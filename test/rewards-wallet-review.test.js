import {test} from 'node:test';import assert from 'node:assert/strict';
import {Keypair,Transaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {reviewWalletAdjustedReward} from '../src/rewards-wallet-review.js';
const payer=Keypair.generate(),recipient=Keypair.generate(),blockhash=Keypair.generate().publicKey.toBase58();
const tx=()=>new Transaction({feePayer:payer.publicKey,recentBlockhash:blockhash}).add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:recipient.publicKey,lamports:200000000}));
const wire=t=>t.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
const options={baseNetworkFeeLamports:'5000',maxNetworkFeeLamports:'100000'};
const priority=t=>t.add(ComputeBudgetProgram.setComputeUnitLimit({units:80000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:900000}));
test('wallet priority instructions preserve the signed reviewed action and remain within fee allowance',()=>{
 const original=wire(tx()),signed=priority(tx());signed.sign(payer);
 assert.equal(signed.verifySignatures(),true);assert.equal(reviewWalletAdjustedReward(original,wire(signed),options),true);
 assert.equal(reviewWalletAdjustedReward(original,original,options),true);
});
test('wallet fee review rejects extra transfers, changed amount, payer, blockhash and access rights',()=>{
 const original=wire(tx());
 const hidden=priority(tx()).add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:recipient.publicKey,lamports:1}));
 assert.equal(reviewWalletAdjustedReward(original,wire(hidden),options),false);
 const amount=priority(tx());amount.instructions[0].data[4]^=1;assert.equal(reviewWalletAdjustedReward(original,wire(amount),options),false);
 const payerChange=priority(tx());payerChange.feePayer=recipient.publicKey;assert.equal(reviewWalletAdjustedReward(original,wire(payerChange),options),false);
 const hash=priority(tx());hash.recentBlockhash=recipient.publicKey.toBase58();assert.equal(reviewWalletAdjustedReward(original,wire(hash),options),false);
 const access=priority(tx());access.instructions[0].keys[1].isSigner=true;assert.equal(reviewWalletAdjustedReward(original,wire(access),options),false);
});
test('wallet fee review rejects excessive compute limits, excessive fees, duplicates and unknown budgets',()=>{
 const original=wire(tx());
 const excessive=tx().add(ComputeBudgetProgram.setComputeUnitLimit({units:80000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:2000000}));
 assert.equal(reviewWalletAdjustedReward(original,wire(excessive),options),false);
 assert.equal(reviewWalletAdjustedReward(original,wire(tx().add(ComputeBudgetProgram.setComputeUnitLimit({units:200001}))),options),false);
 assert.equal(reviewWalletAdjustedReward(original,wire(priority(tx()).add(ComputeBudgetProgram.setComputeUnitPrice({microLamports:1}))),options),false);
 assert.equal(reviewWalletAdjustedReward(original,wire(tx().add(ComputeBudgetProgram.requestHeapFrame({bytes:32768}))),options),false);
 assert.equal(reviewWalletAdjustedReward(original,wire(priority(tx())),{...options,maxNetworkFeeLamports:'100001'}),false);
 assert.equal(reviewWalletAdjustedReward(original,'AAAA',options),false);
});
