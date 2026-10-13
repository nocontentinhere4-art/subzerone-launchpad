import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { makeEnv, harness, user } from './helpers.js';
import { REWARDS, buildRewardManifest, manifestTree, verifyRewardProof, rewardAddresses, hasClaimed, publishInstruction, epochBounds, u64 } from '../src/rewards-protocol.js';
import { createRewardsPool } from '../src/rewards-pool.js';
import { sha256 } from '../src/util.js';

const program=Keypair.generate().publicKey.toBase58();
const alice=Keypair.generate(),bob=Keypair.generate();
const input=(epochId=0)=>({program,epochId,creatorRewardsLamports:'1000000000',sourceDigest:'a'.repeat(64),snapshotSlot:456606960,snapshotAt:Date.parse(REWARDS.startsAt)+86400000,excludedWallets:[],
  entries:[{wallet:alice.publicKey.toBase58(),weight:'100000000000'},{wallet:bob.publicKey.toBase58(),weight:'200000000000'}]});
const after=Date.parse(REWARDS.startsAt)+3*86400000;
const account=(data,owner=program,lamports=200000000+1726080,executable=false)=>({data:[data.toString('base64'),'base64'],owner,lamports,executable});
function epochAccount(m) {const b=Buffer.alloc(120);b.write('S01EPOCH');new PublicKey(REWARDS.fundingWallet).toBuffer().copy(b,8);Buffer.from(m.root,'hex').copy(b,40);
  u64(m.epochId).copy(b,72);u64(m.holderPoolLamports).copy(b,80);u64(m.creatorRewardsLamports).copy(b,96);u64(m.from/1000).copy(b,104);u64(m.to/1000).copy(b,112);return account(b);}

test('allocation is reproducible, preserves lamports and binds every proof',()=>{
  const m=buildRewardManifest(input(),after),tree=manifestTree(m);
  assert.equal(m.weighting,'snapshot-balance');
  assert.throws(()=>buildRewardManifest({...input(),snapshotSlot:undefined},after));
  assert.throws(()=>buildRewardManifest({...input(),snapshotAt:after+1},after));
  assert.throws(()=>buildRewardManifest({...input(),snapshotAt:Date.parse(REWARDS.startsAt)},after));
  assert.equal(m.entries.reduce((s,e)=>s+BigInt(e.lamports),0n),200000000n);
  assert.equal(buildRewardManifest({...input(),entries:[...input().entries].reverse()},after).root,m.root);
  for(let i=0;i<m.entries.length;i++){const e=m.entries[i],proof=tree.proof(i);assert(verifyRewardProof(program,0,e.wallet,BigInt(e.lamports),proof,m.root));
    assert(!verifyRewardProof(program,1,e.wallet,BigInt(e.lamports),proof,m.root));assert(!verifyRewardProof(program,0,e.wallet,BigInt(e.lamports)+1n,proof,m.root));}
  assert.throws(()=>buildRewardManifest({...input(),excludedWallets:[alice.publicKey.toBase58()]},after));
  assert.throws(()=>buildRewardManifest({...input(),entries:[input().entries[0],input().entries[0]]},after));
  assert.throws(()=>buildRewardManifest(input(),Date.parse(REWARDS.startsAt)+1000));
});

test('initial one-SOL budget is a separate nonretroactive bootstrap period',()=>{
  const snapshotEnd=Date.parse(REWARDS.startsAt)+100000;
  const m=buildRewardManifest({...input(REWARDS.bootstrapEpochId),snapshotEnd},after);
  assert.equal(m.kind,'bootstrap');assert.equal(m.from,Date.parse(REWARDS.startsAt));assert.equal(m.to,snapshotEnd);
  assert.equal(publishInstruction(m).data.length,57);
  assert.throws(()=>buildRewardManifest({...input(REWARDS.bootstrapEpochId),snapshotEnd,creatorRewardsLamports:'297200000'},after));
  assert.throws(()=>buildRewardManifest({...input(REWARDS.bootstrapEpochId),snapshotEnd:Date.parse(REWARDS.startsAt)-1000},after));
});

test('claim bitmap validates owner and paged identity, including page boundary',()=>{
  const b=Buffer.alloc(80);b.write('S01CLAIM');alice.publicKey.toBuffer().copy(b,8);u64(1).copy(b,40);b[48]=1;
  assert(hasClaimed(account(b),program,255,alice.publicKey.toBase58()));
  assert(!hasClaimed(account(b),program,256,alice.publicKey.toBase58()));
  assert.throws(()=>hasClaimed(account(b),program,0,alice.publicKey.toBase58()));
  assert.throws(()=>hasClaimed(account(b,SystemProgram.programId.toBase58()),program,256,alice.publicKey.toBase58()));
});

test('backend verifies on-chain funding; accepts only the reviewed signed claim',async()=>{
  const {cfg,db}=makeEnv();cfg.rewards={program,network:'devnet',rpcUrl:'https://rpc.test',programHash:sha256(Buffer.from([1,2,3])),programBytes:3};
  const programData=Keypair.generate().publicKey;
  const m=buildRewardManifest(input(),after),state={epoch:epochAccount(m),claimed:false,sends:0};
  const fetchImpl=async (url,init)=>{const {method,params}=JSON.parse(init.body);let result;
    if(method==='getAccountInfo'){const b=Buffer.alloc(params[0]===program?36:48);b.writeUInt32LE(params[0]===program?2:3,0);
      if(params[0]===program)programData.toBuffer().copy(b,4);else Buffer.from([1,2,3]).copy(b,45);
      result={value:account(b,'BPFLoaderUpgradeab1e11111111111111111111111',1,params[0]===program)};}
    else if(method==='getMultipleAccounts')result={context:{slot:44},value:params[0].map((_,i)=>i===0?state.epoch:null)};
    else if(method==='getMinimumBalanceForRentExemption')result=params[0]===120?1726080:1447680;
    else if(method==='getLatestBlockhash')result={value:{blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}};
    else if(method==='getFeeForMessage')result={value:5000};
    else if(method==='getBalance')result={value:1000000000};
    else if(method==='simulateTransaction')result={value:{err:null}};
    else if(method==='getBlockHeight')result=50;
    else if(method==='sendTransaction'){state.sends++;result='2'.repeat(88);}
    else if(method==='getSignatureStatuses')result={value:[{err:null,confirmationStatus:'finalized'}]};
    else throw Error(method);
    return new Response(JSON.stringify({result}),{status:200});};
  const pool=createRewardsPool({cfg,db,fetchImpl,now:()=>after});
  await assert.rejects(pool.registerManifest(input(),alice.publicKey.toBase58()),e=>e.status===403);
  await pool.registerManifest(input(),REWARDS.fundingWallet);
  const personal=await pool.personal(alice.publicKey.toBase58());assert.equal(personal.claimableLamports,m.entries.find(e=>e.wallet===alice.publicKey.toBase58()).lamports);
  const prepared=await pool.prepare(alice.publicKey.toBase58(),0),tx=Transaction.from(Buffer.from(prepared.transaction,'base64'));
  assert.equal(tx.instructions.length,1);assert.equal(tx.instructions[0].programId.toBase58(),program);tx.sign(alice);
  await assert.rejects(pool.submit(bob.publicKey.toBase58(),prepared.intentId,tx.serialize().toString('base64')),e=>e.status===404);
  const changed=Transaction.from(Buffer.from(prepared.transaction,'base64'));changed.add(SystemProgram.transfer({fromPubkey:alice.publicKey,toPubkey:bob.publicKey,lamports:1}));changed.sign(alice);
  await assert.rejects(pool.submit(alice.publicKey.toBase58(),prepared.intentId,changed.serialize().toString('base64')),e=>e.code==='reward_transaction_mismatch');
  const out=await pool.submit(alice.publicKey.toBase58(),prepared.intentId,tx.serialize().toString('base64'));assert.equal(out.status,'submitted');
  await pool.submit(alice.publicKey.toBase58(),prepared.intentId,tx.serialize().toString('base64'));assert.equal(state.sends,1);
  assert.equal((await pool.status(alice.publicKey.toBase58(),prepared.intentId)).status,'finalized');
  state.epoch.lamports=1;assert.equal((await pool.publicView()).status,'unavailable');
  await assert.rejects(pool.prepare(alice.publicKey.toBase58(),0));db.close();
});

test('public pool is readable without sign-in; claim APIs require the session wallet',async()=>{
  const h=await harness();try{const w=user(h.db),client=h.client(w);
    assert.equal((await client.call('GET','/api/rewards/pool')).json.status,'setup_required');
    assert.equal((await client.call('GET','/api/rewards/me')).status,401);
    assert.equal((await client.call('POST','/api/rewards/claims/prepare',{epochId:0})).status,401);
    await client.signIn();const me=await client.call('GET','/api/rewards/me');assert.equal(me.json.wallet,w.address);assert.equal(me.json.claimableLamports,null);
    assert.equal((await client.call('POST','/api/rewards/claims/prepare',{epochId:0})).status,503);
  }finally{h.close();}
});
