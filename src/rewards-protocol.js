import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { HttpError } from './util.js';

export const REWARDS = Object.freeze({
  version: 1, mint: '6WCtKQfkWurd77tCCAYWuL5TwyAvuovTzworfnfupump',
  fundingWallet: 'HMPUiULXumamWDhuoKap6ty2hQ7V7GQwi8PZ7pGx6STQ',
  startsAt: '2026-10-13T22:00:00Z', daySeconds: 86400,
  holderBps: 2000, buybackBps: 3000, projectBps: 5000,
  bootstrapEpochId: 100000, initialBudgetLamports: '1000000000',
  weighting: 'time-weighted-balance', epochBytes: 120, claimsBytes: 80,
});
const UINT64 = (1n << 64n) - 1n;
export function uint(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > UINT64) throw new HttpError(400,'bad_reward_amount','Amounts must be unsigned integer strings.');
  return BigInt(value);
}
export function u64(value) { const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; }
export function epochBounds(id) {
  if (!Number.isSafeInteger(id) || id < 0 || id > 100000) throw new HttpError(400,'bad_reward_epoch','Invalid reward period.');
  const from=Date.parse(REWARDS.startsAt)+id*86400000;
  return { from, to: from+86400000 };
}
const sha = (...bytes) => createHash('sha256').update(Buffer.concat(bytes.map(b=>Buffer.from(b)))).digest();
export function rewardLeaf(program,id,wallet,amount) {
  return sha(Buffer.from('SUB01_REWARDS_V1'),new PublicKey(program).toBytes(),new PublicKey(REWARDS.mint).toBytes(),u64(id),new PublicKey(wallet).toBytes(),u64(amount));
}
export function rewardNode(a,b) { return Buffer.compare(a,b)<=0 ? sha(Buffer.from('SUB01_NODE_V1'),a,b) : sha(Buffer.from('SUB01_NODE_V1'),b,a); }
export function merkle(leaves) {
  if (!leaves.length) return null;
  const levels=[leaves.map(b=>Buffer.from(b))];
  while (levels.at(-1).length>1) {const l=levels.at(-1), n=[];for(let i=0;i<l.length;i+=2)n.push(rewardNode(l[i],l[i+1]||l[i]));levels.push(n);}
  return {root:levels.at(-1)[0].toString('hex'),proof(index){const proof=[];for(const l of levels.slice(0,-1)){proof.push((l[index^1]||l[index]).toString('hex'));index=Math.floor(index/2);}return proof;}};
}
export function verifyRewardProof(program,id,wallet,amount,proof,root) {
  try {if(!Array.isArray(proof)||proof.length>32||!/^[a-f0-9]{64}$/.test(root))return false;
    let hash=rewardLeaf(program,id,wallet,amount);for(const p of proof){if(!/^[a-f0-9]{64}$/.test(p))return false;hash=rewardNode(hash,Buffer.from(p,'hex'));}return hash.toString('hex')===root;
  } catch {return false;}
}
export function rewardAddresses(program,id,wallet=null) {
  const pid=new PublicKey(program),mint=new PublicKey(REWARDS.mint);
  const epoch=PublicKey.findProgramAddressSync([Buffer.from('rewards'),mint.toBuffer(),u64(id)],pid)[0];
  const claimIndex=id===REWARDS.bootstrapEpochId?0:id+1;
  const claims=wallet?PublicKey.findProgramAddressSync([Buffer.from('claims'),mint.toBuffer(),new PublicKey(wallet).toBuffer(),u64(Math.floor(claimIndex/256))],pid)[0]:null;
  return {epoch,claims};
}

// Canonical weights are declared by the publisher; this reproducible allocation
// proves the arithmetic. The on-chain root cannot independently verify the indexer.
export function buildRewardManifest({program,epochId,creatorRewardsLamports,entries,excludedWallets,sourceDigest,snapshotEnd},t=Date.now()) {
  new PublicKey(program);
  const bootstrap=epochId===REWARDS.bootstrapEpochId;
  const period=bootstrap?{from:Date.parse(REWARDS.startsAt),to:snapshotEnd}:epochBounds(epochId);
  const creator=uint(creatorRewardsLamports),pool=creator/5n;
  if(bootstrap&&(!Number.isSafeInteger(snapshotEnd)||snapshotEnd%1000!==0||snapshotEnd<=period.from||creator.toString()!==REWARDS.initialBudgetLamports))throw new HttpError(400,'bad_bootstrap_snapshot');
  if(period.to>t || pool===0n)throw new HttpError(400,'period_not_ready','Only closed, nonempty periods can be funded.');
  if(!/^[a-f0-9]{64}$/.test(sourceDigest||''))throw new HttpError(400,'missing_reward_evidence','Supply the SHA-256 digest of the complete balance and fee evidence.');
  if(!Array.isArray(excludedWallets)||excludedWallets.length>1000)throw new HttpError(400,'bad_exclusions');
  const excluded=[...new Set([REWARDS.fundingWallet,...excludedWallets])].sort();excluded.forEach(w=>new PublicKey(w));
  if(!Array.isArray(entries)||entries.length===0||entries.length>10000)throw new HttpError(400,'bad_reward_entries');
  const seen=new Set();const weights=entries.map(e=>{
    new PublicKey(e.wallet);if(seen.has(e.wallet)||excluded.includes(e.wallet))throw new HttpError(400,'duplicate_or_excluded_wallet');seen.add(e.wallet);
    if(typeof e.weight!=='string'||!/^[1-9]\d{0,38}$/.test(e.weight)||BigInt(e.weight)>=(1n<<128n))throw new HttpError(400,'bad_reward_weight');
    const weight=BigInt(e.weight);return {wallet:e.wallet,weight};
  }).sort((a,b)=>(a.wallet<b.wallet?-1:a.wallet>b.wallet?1:0));
  const totalWeight=weights.reduce((sum,e)=>sum+e.weight,0n);
  const allocations=weights.map(e=>({...e,lamports:pool*e.weight/totalWeight,remainder:pool*e.weight%totalWeight}));
  let dust=pool-allocations.reduce((sum,e)=>sum+e.lamports,0n);
  const order=[...allocations].sort((a,b)=>a.remainder===b.remainder?(a.wallet<b.wallet?-1:a.wallet>b.wallet?1:0):a.remainder>b.remainder?-1:1);
  for(let i=0;dust>0n;i++,dust--)order[i].lamports++;
  const final=allocations.map(e=>({wallet:e.wallet,weight:e.weight.toString(),lamports:e.lamports.toString()}));
  const leaves=final.map(e=>rewardLeaf(program,epochId,e.wallet,BigInt(e.lamports)));
  const tree=merkle(leaves);
  return {version:1,program,mint:REWARDS.mint,fundingWallet:REWARDS.fundingWallet,epochId,kind:bootstrap?'bootstrap':'daily',from:period.from,to:period.to,
    creatorRewardsLamports:creator.toString(),holderPoolLamports:pool.toString(),totalWeight:totalWeight.toString(),
    excludedWallets:excluded,sourceDigest,root:tree.root,entries:final};
}
export function manifestTree(m) {return merkle(m.entries.map(e=>rewardLeaf(m.program,m.epochId,e.wallet,BigInt(e.lamports))));}
export function claimInstruction(m,wallet) {
  const index=m.entries.findIndex(e=>e.wallet===wallet),entry=m.entries[index];if(!entry||BigInt(entry.lamports)===0n)throw new HttpError(409,'no_reward');
  const proof=manifestTree(m).proof(index),{epoch,claims}=rewardAddresses(m.program,m.epochId,wallet);
  return new TransactionInstruction({programId:new PublicKey(m.program),keys:[
    {pubkey:new PublicKey(wallet),isSigner:true,isWritable:true},{pubkey:epoch,isSigner:false,isWritable:true},
    {pubkey:claims,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],
    data:Buffer.concat([Buffer.from([1]),u64(m.epochId),u64(entry.lamports),Buffer.from([proof.length]),...proof.map(p=>Buffer.from(p,'hex'))])});
}
export function publishInstruction(m) {
  return new TransactionInstruction({programId:new PublicKey(m.program),keys:[
    {pubkey:new PublicKey(REWARDS.fundingWallet),isSigner:true,isWritable:true},{pubkey:rewardAddresses(m.program,m.epochId).epoch,isSigner:false,isWritable:true},
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([0]),u64(m.epochId),u64(m.creatorRewardsLamports),Buffer.from(m.root,'hex'),...(m.kind==='bootstrap'?[u64(m.to/1000)]:[])])});
}
export function decodeEpoch(info,program,id,periodOverride=null) {
  if(!info || info.owner!==program || info.executable)throw new HttpError(409,'epoch_not_funded','This period is not funded by the rewards contract.');
  const b=Buffer.from(info.data[0],'base64'),period=id===REWARDS.bootstrapEpochId?periodOverride:epochBounds(id);
  if(!period||!Number.isSafeInteger(period.to)||period.from!==Date.parse(REWARDS.startsAt)&&id===REWARDS.bootstrapEpochId)throw new HttpError(409,'invalid_bootstrap_epoch');
  if(b.length!==120||b.subarray(0,8).toString()!=='S01EPOCH'||new PublicKey(b.subarray(8,40)).toBase58()!==REWARDS.fundingWallet||b.readBigUInt64LE(72)!==BigInt(id)
    ||b.readBigUInt64LE(104)!==BigInt(period.from/1000)||b.readBigUInt64LE(112)!==BigInt(period.to/1000))throw new HttpError(409,'invalid_epoch');
  const total=b.readBigUInt64LE(80),claimed=b.readBigUInt64LE(88),creator=b.readBigUInt64LE(96);
  if(total!==creator/5n||claimed>total||!Number.isSafeInteger(info.lamports)||BigInt(info.lamports)<total-claimed)throw new HttpError(409,'invalid_epoch_balance');
  return {root:b.subarray(40,72).toString('hex'),total,claimed,creator};
}
export function hasClaimed(info,program,id,wallet) {
  if(!info)return false;
  // A pre-funded but uninitialized bitmap PDA is safe: the program can allocate it.
  if(info.owner===SystemProgram.programId.toBase58()&&Buffer.from(info.data[0],'base64').length===0)return false;
  const b=Buffer.from(info.data[0],'base64');
  const claimIndex=id===REWARDS.bootstrapEpochId?0:id+1;
  if(info.owner!==program||b.length!==80||b.subarray(0,8).toString()!=='S01CLAIM'||new PublicKey(b.subarray(8,40)).toBase58()!==wallet||b.readBigUInt64LE(40)!==BigInt(Math.floor(claimIndex/256)))throw new HttpError(409,'invalid_claim_history');
  return !!(b[48+Math.floor((claimIndex%256)/8)]&(1<<(claimIndex%8)));
}
