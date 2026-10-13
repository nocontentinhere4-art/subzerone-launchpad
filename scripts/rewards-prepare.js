// Build a funding plan for a verified indexer's input. No private keys or sends.
import { readFileSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { buildRewardManifest, publishInstruction, REWARDS } from '../src/rewards-protocol.js';
const args=process.argv.slice(2),get=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
if(!get('--input')||!get('--output'))throw Error('Usage: node scripts/rewards-prepare.js --input verified-weights.json --output funding-plan.json [--rpc https://devnet-endpoint]');
const input=JSON.parse(readFileSync(get('--input'),'utf8'));
const manifest=buildRewardManifest(input);
const instruction=publishInstruction(manifest);
const plan={manifest,trust:'Weights and creator fee attribution must come from a complete verified indexer; this helper verifies arithmetic only.',
  fundingWallet:REWARDS.fundingWallet,holderDepositLamports:manifest.holderPoolLamports,
  buybackBudgetLamports:(BigInt(manifest.creatorRewardsLamports)*3n/10n).toString(),
  projectBudgetLamports:(BigInt(manifest.creatorRewardsLamports)-BigInt(manifest.holderPoolLamports)-BigInt(manifest.creatorRewardsLamports)*3n/10n).toString(),
  instruction:{program:instruction.programId.toBase58(),accounts:instruction.keys.map(k=>({address:k.pubkey.toBase58(),signer:k.isSigner,writable:k.isWritable})),dataBase64:instruction.data.toString('base64')},
  transaction:null};
if(get('--rpc')){
  if(!/^https:\/\//.test(get('--rpc')))throw Error('RPC must use HTTPS');
  const connection=new Connection(get('--rpc'),'finalized');
  const block=await connection.getLatestBlockhash('finalized');
  const tx=new Transaction({feePayer:new PublicKey(REWARDS.fundingWallet),recentBlockhash:block.blockhash}).add(instruction);
  plan.escrowRentLamports=await connection.getMinimumBalanceForRentExemption(REWARDS.epochBytes);
  plan.transaction=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
  plan.lastValidBlockHeight=block.lastValidBlockHeight;
  plan.networkFeeLamports=(await connection.getFeeForMessage(tx.compileMessage(),'finalized')).value;
  const simulation=await connection.simulateTransaction(tx);
  if(simulation.value.err)throw Error('Funding simulation failed; no transaction was sent.');
}
writeFileSync(get('--output'),JSON.stringify(plan,null,2));
console.log('Prepared funding plan. Nothing signed or sent.');
