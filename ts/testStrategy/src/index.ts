import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
	Connection,
	PublicKey,
	TransactionInstruction,
	clusterApiUrl,
} from '@solana/web3.js';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import * as anchor from '@coral-xyz/anchor';
import {
	BASE_PRECISION,
	BN,
	DriftClient,
	FastSingleTxSender,
	MarketType,
	PRICE_PRECISION,
	PositionDirection,
	PostOnlyParams,
	TEN,
	convertToNumber,
	getLimitOrderParams,
	getOrderParams,
	DriftEnv
} from '@drift-labs/sdk';

import { VAULT_PROGRAM_ID, VaultClient } from '../../sdk/src';
import { IDL } from '../../sdk/src/types/drift_vaults';

import { calculateAccountValueUsd, getWallet } from './utils';

import dotenv from 'dotenv';
dotenv.config();

// const SOL_MARKET_ID = 1;
// const USDC_MARKET_ID = 0;
const SPOT_MARKET_NAME = "USDC";
const PERP_MARKET_NAME = "SOL-PERP";
// const PERP_MARKET_TO_MM = 0; // SOL-PERP
const MM_EDGE_BPS = 10;
const BPS_BASE = 10000;
const PCT_ACCOUNT_VALUE_TO_QUOTE = 0.1; // quote 10% of account value per side
const SUFFICIENT_QUOTE_CHANGE_BPS = 2; // only requote if quote price changes by 2 bps

const stateCommitment = 'confirmed';

const delegatePrivateKey = process.env.DELEGATE_PRIVATE_KEY;
if (!delegatePrivateKey) {
	throw new Error('DELEGATE_PRIVATE_KEY not set');
}

const _network = (process.env.ENV || 'devnet');

const driftEnv = _network as DriftEnv;

const clustEnv = WalletAdapterNetwork[_network];

const [_, delegateWallet] = getWallet(delegatePrivateKey);

const connection = new Connection(clusterApiUrl(clustEnv), stateCommitment);

console.log(`Wallet: ${delegateWallet.publicKey.toBase58()}`);
console.log(`endpoint: ${connection.rpcEndpoint}`);

const vaultAddressString = process.env.VAULT_ADDRESS;
if (!vaultAddressString) {
	throw new Error('must set VAULT_ADDRESS not set');
}
const vaultAddress = new PublicKey(vaultAddressString);

const driftClient = new DriftClient({
	connection,
	wallet: delegateWallet,
	env:driftEnv,
	opts: {
		commitment: stateCommitment,
		skipPreflight: false,
		preflightCommitment: stateCommitment,
	},
	authority: vaultAddress, // this is the vault's address with a drift account
	activeSubAccountId: 0, // vault should only have subaccount 0
	subAccountIds: [0],
	txSender: new FastSingleTxSender({
		connection,
		wallet: delegateWallet,
		opts: {
			commitment: stateCommitment,
			skipPreflight: false,
			preflightCommitment: stateCommitment,
		},
		timeout: 3000,
		blockhashRefreshInterval: 1000,
	}),
});
let driftLookupTableAccount: AddressLookupTableAccount | undefined;

const vaultProgramId = VAULT_PROGRAM_ID;
const vaultProgram = new anchor.Program(
	IDL,
	vaultProgramId,
	driftClient.provider
);
const driftVault = new VaultClient({
	driftClient: driftClient as any,
	program: vaultProgram as any,
	cliMode: false,
});
// let vault: Vault | undefined;

// async function updateVaultAccount() {
// 	// makes RPC request to fetch vault state
// 	vault = await driftVault.getVault(vaultAddress);
// }

let lastBid: number | undefined;
let lastAsk: number | undefined;
function sufficientQuoteChange(newBid: number, newAsk: number): boolean {
	if (lastBid === undefined || lastAsk === undefined) {
		return true;
	}
	const bidDiff = newBid / lastBid - 1;
	const askDiff = newAsk / lastAsk - 1;

	if (
		Math.abs(bidDiff) > SUFFICIENT_QUOTE_CHANGE_BPS / BPS_BASE ||
		Math.abs(askDiff) > SUFFICIENT_QUOTE_CHANGE_BPS / BPS_BASE
	) {
		return true;
	}

	return false;
}


async function runMmLoop() {

	const user = driftClient.getUser();
	const vault = await driftVault.getVault(vaultAddress);
	if (!vault) {
		console.log(`Vault has not been loaded yet`);
		return;
	}

	// market_index, market_type
	const spot_market_info = driftClient.getMarketIndexAndType(SPOT_MARKET_NAME);
	const perp_market_info = driftClient.getMarketIndexAndType(PERP_MARKET_NAME);

	const tokenSpotMarket = driftClient.getSpotMarketAccount(spot_market_info.marketIndex);
	if (!tokenSpotMarket) {
		throw new Error(`No spot market found for specific token being chosen`);
	}


	const usdcPrecision = TEN.pow(new BN(tokenSpotMarket.decimals));
	const vaultWithdrawalsRequested = convertToNumber(
		vault.totalWithdrawRequested,
		usdcPrecision
	);
	const currentAccountValue = calculateAccountValueUsd(user);
	const accessibleAccountValue =
		currentAccountValue - vaultWithdrawalsRequested;
	console.log(
		`Current vault equity: ${currentAccountValue}, withdrawals requested: ${vaultWithdrawalsRequested}`
	);

	const perpOracle = driftClient.getOracleDataForPerpMarket(perp_market_info.marketIndex);

	const oraclePriceNumber = convertToNumber(perpOracle.price, PRICE_PRECISION);
	const baseToQuote =
		(accessibleAccountValue * PCT_ACCOUNT_VALUE_TO_QUOTE) / oraclePriceNumber;

	const newBid = oraclePriceNumber * (1 - MM_EDGE_BPS / BPS_BASE);
	const newAsk = oraclePriceNumber * (1 + MM_EDGE_BPS / BPS_BASE);
	console.log(`New bid: ${newBid}, new ask: ${newAsk}`);

	// only requote on sufficient change
	if (!sufficientQuoteChange(newBid, newAsk)) {
		console.log(`Not re-quoting, insufficient change`);
		return;
	}

	// cancel orders and place new ones
	const ixs: Array<TransactionInstruction> = [];
	ixs.push(
		ComputeBudgetProgram.setComputeUnitLimit({
			units: 1_400_000,
		})
	);
	ixs.push(
		await driftClient.getCancelOrdersIx(
			MarketType.PERP,
			perp_market_info.marketIndex,
			null
		)
	);
	ixs.push(
		await driftClient.getPlaceOrdersIx([
			getOrderParams(
				getLimitOrderParams({
					marketType: MarketType.PERP,
					marketIndex: perp_market_info.marketIndex,
					direction: PositionDirection.LONG,
					baseAssetAmount: new BN(baseToQuote * BASE_PRECISION.toNumber()),
					price: new BN(newBid * PRICE_PRECISION.toNumber()),
					postOnly: PostOnlyParams.SLIDE, // will adjust crossing orders s.t. they don't cross
				})
			),
			getOrderParams(
				getLimitOrderParams({
					marketType: MarketType.PERP,
					marketIndex: perp_market_info.marketIndex,
					direction: PositionDirection.SHORT,
					baseAssetAmount: new BN(baseToQuote * BASE_PRECISION.toNumber()),
					price: new BN(newAsk * PRICE_PRECISION.toNumber()),
					postOnly: PostOnlyParams.SLIDE, // will adjust crossing orders s.t. they don't cross
				})
			),
		])
	);
	const txSig = await driftClient.txSender.sendVersionedTransaction(
		await driftClient.txSender.getVersionedTransaction(
			ixs,
			[driftLookupTableAccount!],
			[],
			driftClient.opts
		)
	);
	console.log(
		`Requoting ${baseToQuote} SOL, ${newBid} @ ${newAsk}, oracle: ${oraclePriceNumber}, tx: https://solscan.io/tx/${txSig.txSig}`
	);

	lastBid = newBid;
	lastAsk = newAsk;
}

async function main() {

	await driftClient.subscribe();

	driftLookupTableAccount = await driftClient.fetchMarketLookupTableAccount();

	console.log(driftLookupTableAccount);

	
	console.log(`Starting Basic Vault Strategy`);
	console.log(` Vault: ${vaultAddress.toBase58()}`);
	console.log(` Trading as delegate: ${delegateWallet.publicKey.toBase58()}`);
	
	// run mm loop every 10s
	setInterval(runMmLoop, 10000);
	
	// update vault account in the background, it's less critical
	// setInterval(updateVaultAccount, 60000);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
