import { PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { HttpError, sha256, token, isSolanaAddress } from './util.js';
import { REWARDS, buildRewardManifest, manifestTree, rewardAddresses, decodeEpoch, hasClaimed, claimInstruction, epochBounds } from './rewards-protocol.js';

export function createRewardsPool({db,cfg,fetchImpl=fetch,now=Date.now}) {
  const settings=cfg.rewards||{};
  const program=settings.program||null,network=settings.network||'devnet';
  const rpcUrl=settings.rpcUrl||'https://api.devnet.solana.com';
  const link=(kind,address)=>`https://explorer.solana.com/${kind}/${address}${network==='devnet'?'?cluster=devnet':''}`;
  const configured=!!program;
  async function rpc(method,params) {
    const response=await fetchImpl(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new HttpError(503,'reward_rpc_unavailable','The rewards chain reader is unavailable.');
    const body=await response.json();if(body.error)throw new HttpError(503,'reward_rpc_error','The rewards chain reader could not verify this request.');
    return body.result;
  }
  const account=async address=>(await rpc('getAccountInfo',[address,{encoding:'base64',commitment:'finalized'}]))?.value;
  const rowFor=id=>db.get('SELECT * FROM sub01_reward_epochs WHERE epoch_id = ?',id);
  const manifestFor=id=>{const row=rowFor(id);if(!row)throw new HttpError(404,'reward_period_missing');return JSON.parse(row.manifest_json);};
  function requireConfigured() {if(!configured)throw new HttpError(503,'reward_setup_required','The claim contract has not been configured yet.');}
  async function deployed() {
    requireConfigured();const info=await account(program);
    if(!info?.executable)throw new HttpError(503,'reward_contract_missing','The configured claim contract is not deployed.');
    const data=Buffer.from(info.data[0],'base64');
    if(info.owner!=='BPFLoaderUpgradeab1e11111111111111111111111'||data.length!==36||data.readUInt32LE(0)!==2)throw new HttpError(503,'reward_program_unverified','The rewards program loader could not be verified.');
    if(!settings.programHash||!settings.programBytes)throw new HttpError(503,'reward_program_unverified','Configure the reviewed rewards program bytecode hash before enabling claims.');
    const programData=await account(new PublicKey(data.subarray(4,36)).toBase58());
    const binary=programData?Buffer.from(programData.data[0],'base64'):Buffer.alloc(0);
    if(programData?.owner!==info.owner||binary.length<45+settings.programBytes||binary.readUInt32LE(0)!==3||sha256(binary.subarray(45,45+settings.programBytes))!==settings.programHash)throw new HttpError(503,'reward_program_unverified','The deployed program does not match the reviewed bytecode.');
    if(![0,1].includes(binary[12]))throw new HttpError(503,'reward_program_unverified');
    return {upgradeAuthority:binary[12]===1?new PublicKey(binary.subarray(13,45)).toBase58():null};
  }
  async function verified(m,wallet=null) {
    const addresses=rewardAddresses(program,m.epochId,wallet);
    const keys=[addresses.epoch.toBase58(),...(wallet?[addresses.claims.toBase58()]:[])];
    const result=await rpc('getMultipleAccounts',[keys,{encoding:'base64',commitment:'finalized'}]);
    if(!Array.isArray(result?.value)||result.value.length!==keys.length)throw new HttpError(503,'reward_rpc_incomplete');
    const info=result.value[0],state=decodeEpoch(info,program,m.epochId,{from:m.from,to:m.to});
    const rent=await rpc('getMinimumBalanceForRentExemption',[REWARDS.epochBytes,{commitment:'finalized'}]);
    if(!Number.isSafeInteger(rent)||BigInt(info.lamports)-BigInt(rent)<state.total-state.claimed)throw new HttpError(409,'reward_pool_underfunded');
    if(state.root!==m.root||state.creator.toString()!==m.creatorRewardsLamports||state.total.toString()!==m.holderPoolLamports)throw new HttpError(409,'reward_root_mismatch');
    return {state,addresses,slot:result.context?.slot??null,claimed:wallet?hasClaimed(result.value[1],program,m.epochId,wallet):false,bitmap:wallet?result.value[1]:null};
  }
  const policy=()=>({...REWARDS,program,network,period:'24h',claimMode:'funded-merkle-escrow',
    exclusions:'Liquidity pools and project wallets are excluded. Each manifest lists the exact excluded addresses.',
    allocationTrust:'The publisher supplies finalized snapshot balances and attributable creator rewards. The contract enforces the published root, funded amounts and one claim per wallet per period; it does not independently verify snapshot completeness.',
    fundingWalletUrl:link('address',REWARDS.fundingWallet),programUrl:program?link('address',program):null});
  async function publicView() {
    const out={policy:policy(),status:configured?'checking':'setup_required',poolBalanceLamports:null,epochs:[],buybackContributions:[],note:configured?null:'Claim amounts are unavailable until the contract is deployed, the daily ledger is published and the escrow is funded.'};
    if(!configured)return out;
    try {
      const deployment=await deployed();out.upgradeAuthority=deployment.upgradeAuthority;
      const balance=(await rpc('getBalance',[REWARDS.fundingWallet,{commitment:'finalized'}]))?.value;
      if(!Number.isSafeInteger(balance)||balance<0)throw new HttpError(503,'reward_balance_unknown');out.poolBalanceLamports=String(balance);
      const rows=db.all('SELECT * FROM sub01_reward_epochs ORDER BY epoch_id DESC LIMIT 30');
      for(const row of rows) {const m=JSON.parse(row.manifest_json),v=await verified(m);
        out.epochs.push({epochId:m.epochId,kind:m.kind,from:m.from,to:m.to,root:m.root,manifestHash:row.manifest_hash,
          creatorRewardsLamports:m.creatorRewardsLamports,holderPoolLamports:m.holderPoolLamports,paidLamports:v.state.claimed.toString(),remainingLamports:(v.state.total-v.state.claimed).toString(),
          escrow:v.addresses.epoch.toBase58(),escrowUrl:link('address',v.addresses.epoch.toBase58()),manifestUrl:`/api/rewards/epochs/${m.epochId}`,slot:v.slot});}
      const contributions=db.all("SELECT amount_lamports,signature,epoch_id FROM sub01_reward_claim_intents WHERE destination='buyback' AND signature IS NOT NULL GROUP BY signature ORDER BY MAX(created_at) DESC LIMIT 30");
      if(contributions.length){
        const statuses=(await rpc('getSignatureStatuses',[contributions.map(r=>r.signature),{searchTransactionHistory:true}]))?.value;
        if(!Array.isArray(statuses)||statuses.length!==contributions.length)throw new HttpError(503,'reward_contributions_unverified');
        out.buybackContributions=contributions.filter((r,i)=>!statuses[i]?.err&&statuses[i]?.confirmationStatus==='finalized').map(r=>({epochId:r.epoch_id,amountLamports:r.amount_lamports,signature:r.signature,url:link('tx',r.signature),destination:REWARDS.fundingWallet,status:'contributed_not_burned'}));
      }
      out.status='ready';out.note='The funding wallet balance is separate from funded daily escrows. Only published, funded periods can be claimed.'+(out.upgradeAuthority?' The contract is upgradeable by '+out.upgradeAuthority+'.':' The contract has no upgrade authority.');
    } catch(e) {out.status='unavailable';out.note=e instanceof HttpError?e.message:'Could not verify the reward pool. No live amounts are shown.';out.poolBalanceLamports=null;out.epochs=[];out.buybackContributions=[];}
    return out;
  }
  async function personal(wallet) {
    if(!configured)return {wallet,status:'setup_required',claimableLamports:null,paidLamports:null,earnedLamports:null,epochs:[]};
    await deployed();
    const rows=db.all('SELECT * FROM sub01_reward_epochs ORDER BY epoch_id DESC');
    let earned=0n,paid=0n;const epochs=[];
    for(const row of rows) {const m=JSON.parse(row.manifest_json),index=m.entries.findIndex(e=>e.wallet===wallet);if(index<0)continue;
      const e=m.entries[index],v=await verified(m,wallet),amount=BigInt(e.lamports);earned+=amount;if(v.claimed)paid+=amount;
      epochs.push({epochId:m.epochId,kind:m.kind,from:m.from,to:m.to,amountLamports:e.lamports,weight:e.weight,totalWeight:m.totalWeight,
        claimed:v.claimed,root:m.root,proof:manifestTree(m).proof(index),escrow:v.addresses.epoch.toBase58(),escrowUrl:link('address',v.addresses.epoch.toBase58()),manifestUrl:`/api/rewards/epochs/${m.epochId}`});}
    return {wallet,status:'ready',earnedLamports:earned.toString(),paidLamports:paid.toString(),claimableLamports:(earned-paid).toString(),epochs,
      note:'Only closed, published and funded periods are included. Current-period or missing-indexer accrual is not estimated as claimable.'};
  }
  async function registerManifest(input,wallet) {
    requireConfigured();if(wallet!==REWARDS.fundingWallet)throw new HttpError(403,'reward_funder_only');
    const m=buildRewardManifest({...input,program},now());
    await deployed();await verified(m);
    const json=JSON.stringify(m),hash=sha256(json),old=rowFor(m.epochId);
    if(old){if(old.manifest_hash!==hash)throw new HttpError(409,'reward_manifest_immutable');return {ok:true,epochId:m.epochId,manifestHash:hash};}
    db.run('INSERT INTO sub01_reward_epochs (epoch_id,root,manifest_json,manifest_hash,published_by,published_at) VALUES (?,?,?,?,?,?)',m.epochId,m.root,json,hash,wallet,Date.now());
    return {ok:true,epochId:m.epochId,manifestHash:hash};
  }
  async function prepare(wallet,id,destination='wallet') {
    if(!['wallet','buyback'].includes(destination))throw new HttpError(400,'bad_reward_destination');
    await deployed();const m=manifestFor(id),e=m.entries.find(e=>e.wallet===wallet);if(!e||BigInt(e.lamports)===0n)throw new HttpError(409,'no_reward','No reward is allocated to this wallet in that period.');
    const v=await verified(m,wallet);if(v.claimed)throw new HttpError(409,'already_claimed','This daily reward was already claimed.');
    const block=(await rpc('getLatestBlockhash',[{commitment:'finalized'}]))?.value;
    if(!block?.blockhash||!Number.isSafeInteger(block.lastValidBlockHeight))throw new HttpError(503,'reward_blockhash_unavailable');
    const tx=new Transaction({feePayer:new PublicKey(wallet),recentBlockhash:block.blockhash}).add(claimInstruction(m,wallet));
    if(destination==='buyback')tx.add(SystemProgram.transfer({fromPubkey:new PublicKey(wallet),toPubkey:new PublicKey(REWARDS.fundingWallet),lamports:BigInt(e.lamports)}));
    const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
    const fee=(await rpc('getFeeForMessage',[tx.serializeMessage().toString('base64'),{commitment:'finalized'}]))?.value;
    const needsBitmap=!v.bitmap||v.bitmap.owner==='11111111111111111111111111111111';
    const rent=needsBitmap?await rpc('getMinimumBalanceForRentExemption',[REWARDS.claimsBytes,{commitment:'finalized'}]):0;
    if(!Number.isSafeInteger(fee)||fee<0||!Number.isSafeInteger(rent)||rent<0)throw new HttpError(503,'reward_cost_unknown');
    const balance=(await rpc('getBalance',[wallet,{commitment:'finalized'}]))?.value;
    if(!Number.isSafeInteger(balance)||BigInt(balance)<BigInt(fee)+BigInt(rent))throw new HttpError(409,'claim_cost_balance','Your wallet needs enough SOL for the network fee and claim-record deposit before claiming.');
    const sim=(await rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'finalized'}]))?.value;
    if(!sim||sim.err)throw new HttpError(409,'reward_simulation_failed','The claim could not be simulated successfully. Nothing was sent.');
    const intent=token(16),expires=Date.now()+90000;
    db.run('INSERT INTO sub01_reward_claim_intents (id,wallet,epoch_id,amount_lamports,message_hash,expires_at,last_valid_block_height,created_at,destination) VALUES (?,?,?,?,?,?,?,?,?)',
      intent,wallet,id,e.lamports,sha256(tx.serializeMessage()),expires,block.lastValidBlockHeight,Date.now(),destination);
    return {intentId:intent,transaction:raw,wallet,program,network,chain:network==='devnet'?'solana:devnet':'solana:mainnet',
      destination,buybackWallet:destination==='buyback'?REWARDS.fundingWallet:null,contributionLamports:destination==='buyback'?e.lamports:'0',
      amountLamports:e.lamports,networkFeeLamports:String(fee),claimRecordDepositLamports:String(rent),netLamports:((destination==='wallet'?BigInt(e.lamports):0n)-BigInt(fee)-BigInt(rent)).toString(),
      escrow:v.addresses.epoch.toBase58(),claimRecord:v.addresses.claims.toBase58(),escrowUrl:link('address',v.addresses.epoch.toBase58()),epochId:id,expiresAt:expires,
      actions:[destination==='buyback'?'Claim and atomically transfer your entire allocation to the project wallet for SUB-01 buyback and burn. This contributes SOL; it does not execute a token burn.':'Receive your allocated SOL from the funded daily escrow.','Pay the network fee.','Create a claim bitmap if needed; its deposit is not refundable by this version.'],
      doesNot:['No SUB-01 tokens are transferred or burned.','No token-spending approval or private key is requested.']};
  }
  async function submit(wallet,intentId,signed) {
    const intent=db.get('SELECT * FROM sub01_reward_claim_intents WHERE id=? AND wallet=?',intentId,wallet);if(!intent)throw new HttpError(404,'reward_intent_missing');
    if(intent.signature)return {signature:intent.signature,url:link('tx',intent.signature),status:'submitted'};
    if(Date.now()>intent.expires_at)throw new HttpError(409,'reward_intent_expired');
    if(typeof signed!=='string'||signed.length>6000||!/^[A-Za-z0-9+/]+={0,2}$/.test(signed))throw new HttpError(400,'invalid_reward_transaction');
    let tx;try{tx=Transaction.from(Buffer.from(signed,'base64'));}catch{throw new HttpError(400,'invalid_reward_transaction');}
    if(tx.feePayer?.toBase58()!==wallet||sha256(tx.serializeMessage())!==intent.message_hash||!tx.verifySignatures())throw new HttpError(400,'reward_transaction_mismatch','The signed transaction differs from the reviewed claim.');
    const height=await rpc('getBlockHeight',[{commitment:'finalized'}]);if(!Number.isSafeInteger(height)||height>intent.last_valid_block_height)throw new HttpError(409,'reward_intent_expired');
    const signature=await rpc('sendTransaction',[signed,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:3}]);
    if(typeof signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))throw new HttpError(503,'reward_submit_unknown');
    db.run('UPDATE sub01_reward_claim_intents SET signature=? WHERE id=?',signature,intentId);
    return {signature,url:link('tx',signature),status:'submitted'};
  }
  async function status(wallet,intentId) {
    const intent=db.get('SELECT * FROM sub01_reward_claim_intents WHERE id=? AND wallet=?',intentId,wallet);if(!intent)throw new HttpError(404,'reward_intent_missing');
    if(!intent.signature)return {status:Date.now()>intent.expires_at?'expired':'awaiting_signature'};
    const chain=(await rpc('getSignatureStatuses',[[intent.signature],{searchTransactionHistory:true}]))?.value?.[0];
    return {signature:intent.signature,url:link('tx',intent.signature),status:chain?.err?'failed':chain?.confirmationStatus==='finalized'?'finalized':'confirming'};
  }
  return {publicView,personal,registerManifest,prepare,submit,status,manifest(id){const m=manifestFor(id);return {manifest:m,sha256:rowFor(id).manifest_hash};}};
}

export function rewardsSettings(env) {
  const network=env.SUB01_REWARDS_NETWORK||'devnet',program=env.SUB01_REWARDS_PROGRAM_ID||'';
  if(!['devnet','mainnet-beta'].includes(network)||program&&!isSolanaAddress(program))throw new Error('Invalid SUB01 rewards network or program ID');
  const rpcUrl=env.SUB01_REWARDS_RPC_URL||'https://api.devnet.solana.com';
  if(!/^https:\/\//.test(rpcUrl))throw new Error('SUB01_REWARDS_RPC_URL must be https://');
  if(program&&network==='mainnet-beta'&&!env.SUB01_REWARDS_RPC_URL)throw new Error('Set a dedicated mainnet SUB01_REWARDS_RPC_URL explicitly');
  const programHash=env.SUB01_REWARDS_PROGRAM_SHA256||'',programBytes=Number(env.SUB01_REWARDS_PROGRAM_BYTES||0);
  if(programHash&&!/^[a-f0-9]{64}$/.test(programHash)||!Number.isSafeInteger(programBytes)||programBytes<0||programBytes>1048576)throw new Error('Invalid rewards bytecode hash or length');
  return {program,network,rpcUrl,programHash,programBytes};
}
