#![allow(unexpected_cfgs)]
use solana_program::{
    account_info::{next_account_info, AccountInfo}, clock::Clock,
    entrypoint::ProgramResult, hash::hashv, program::{invoke, invoke_signed},
    program_error::ProgramError, pubkey, pubkey::Pubkey, rent::Rent,
    system_instruction, system_program, sysvar::Sysvar,
};

pub const MINT: Pubkey = pubkey!("6WCtKQfkWurd77tCCAYWuL5TwyAvuovTzworfnfupump");
#[cfg(not(test))]
pub const FUNDER: Pubkey = pubkey!("HMPUiULXumamWDhuoKap6ty2hQ7V7GQwi8PZ7pGx6STQ");
#[cfg(test)]
pub const FUNDER: Pubkey = pubkey!("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
pub const CUTOFF: u64 = 1_791_928_800; // 2026-10-13T22:00:00Z, Oct 14 midnight Europe/Rome.
pub const DAY: u64 = 86_400;
pub const BOOTSTRAP_ID: u64 = 100_000;
pub const EPOCH_LEN: usize = 120;
pub const CLAIMS_LEN: usize = 80;
const EPOCH_MAGIC: &[u8;8] = b"S01EPOCH";
const CLAIM_MAGIC: &[u8;8] = b"S01CLAIM";

#[repr(u32)]
#[derive(Clone, Copy, Debug)]
pub enum Error { WrongFunder = 1, InvalidEpoch, AlreadyPublished, InvalidProof, AlreadyClaimed, Unfunded, Overflow, InvalidState }
impl From<Error> for ProgramError { fn from(e: Error) -> Self { ProgramError::Custom(e as u32) } }
fn get64(data: &[u8], offset: usize) -> Result<u64,ProgramError> {
    Ok(u64::from_le_bytes(data.get(offset..offset+8).ok_or(ProgramError::InvalidInstructionData)?.try_into().unwrap()))
}
fn put64(data: &mut [u8], offset: usize, value: u64) { data[offset..offset+8].copy_from_slice(&value.to_le_bytes()); }
pub fn epoch_bounds(id: u64) -> Result<(u64,u64),ProgramError> {
    let start = id.checked_mul(DAY).and_then(|x| CUTOFF.checked_add(x)).ok_or(Error::Overflow)?;
    let end = start.checked_add(DAY).ok_or(Error::Overflow)?;
    if end > i64::MAX as u64 { return Err(Error::InvalidEpoch.into()); }
    Ok((start,end))
}
pub fn leaf(program: &Pubkey, id: u64, wallet: &Pubkey, amount: u64) -> [u8;32] {
    hashv(&[b"SUB01_REWARDS_V1",program.as_ref(),MINT.as_ref(),&id.to_le_bytes(),wallet.as_ref(),&amount.to_le_bytes()]).to_bytes()
}
pub fn node(a: &[u8;32], b: &[u8;32]) -> [u8;32] {
    let (left,right) = if a <= b {(a,b)} else {(b,a)};
    hashv(&[b"SUB01_NODE_V1",left,right]).to_bytes()
}
pub fn verify_proof(mut value: [u8;32], proof: &[u8], root: &[u8]) -> bool {
    if proof.len() % 32 != 0 || proof.len() > 32*32 || root.len()!=32 { return false; }
    for sibling in proof.chunks_exact(32) { value = node(&value,sibling.try_into().unwrap()); }
    value.as_slice() == root
}

// Allocate/assign separately so unsolicited SOL sent to a PDA cannot block creation.
fn create_pda<'a>(payer: &AccountInfo<'a>, account: &AccountInfo<'a>, system: &AccountInfo<'a>,
                  program: &Pubkey, len: usize, seeds: &[&[u8]]) -> ProgramResult {
    if system.key != &system_program::id() || account.owner != &system_program::id() || !account.data_is_empty() {
        return Err(Error::InvalidState.into());
    }
    let rent = Rent::get()?.minimum_balance(len);
    let needed = rent.saturating_sub(account.lamports());
    if needed > 0 { invoke(&system_instruction::transfer(payer.key,account.key,needed), &[payer.clone(),account.clone(),system.clone()])?; }
    invoke_signed(&system_instruction::allocate(account.key,len as u64), &[account.clone(),system.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(account.key,program), &[account.clone(),system.clone()], &[seeds])
}

#[cfg(not(feature="no-entrypoint"))]
solana_program::entrypoint!(process_instruction);
pub fn process_instruction(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(0) => publish(program,accounts,data),
        Some(1) => claim(program,accounts,data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// data: tag(0), epoch_id(u64), attributable_creator_rewards(u64), immutable_root(32).
// Exactly 20% is escrowed; buyback and project budgets remain outside this program.
fn publish(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if ![49,57].contains(&data.len()) || accounts.len()!=3 { return Err(ProgramError::InvalidInstructionData); }
    let mut iter = accounts.iter();
    let funder = next_account_info(&mut iter)?; let epoch = next_account_info(&mut iter)?; let system = next_account_info(&mut iter)?;
    if !funder.is_signer || !funder.is_writable { return Err(ProgramError::MissingRequiredSignature); }
    if funder.key!=&FUNDER || funder.owner!=&system_program::id() { return Err(Error::WrongFunder.into()); }
    if !epoch.is_writable || system.key!=&system_program::id() { return Err(Error::InvalidState.into()); }
    let id = get64(data,1)?; let creator = get64(data,9)?;
    let total = creator / 5;
    let (start,end)=if id==BOOTSTRAP_ID {
        if data.len()!=57 || creator!=1_000_000_000 {return Err(Error::InvalidEpoch.into());}
        let end=get64(data,49)?;
        if end<=CUTOFF || end>Clock::get()?.unix_timestamp.max(0) as u64 {return Err(Error::InvalidEpoch.into());}
        (CUTOFF,end)
    } else {
        if data.len()!=49 || id>=BOOTSTRAP_ID {return Err(Error::InvalidEpoch.into());}
        epoch_bounds(id)?
    };
    if total==0 || data[17..49].iter().all(|b| *b==0) || Clock::get()?.unix_timestamp < end as i64 { return Err(Error::InvalidEpoch.into()); }
    let id_bytes=id.to_le_bytes(); let (expected,bump)=Pubkey::find_program_address(&[b"rewards",MINT.as_ref(),&id_bytes],program);
    if epoch.key!=&expected { return Err(ProgramError::InvalidSeeds); }
    if epoch.owner==program { return Err(Error::AlreadyPublished.into()); }
    create_pda(funder,epoch,system,program,EPOCH_LEN,&[b"rewards",MINT.as_ref(),&id_bytes,&[bump]])?;
    invoke(&system_instruction::transfer(funder.key,epoch.key,total), &[funder.clone(),epoch.clone(),system.clone()])?;
    let mut state=epoch.try_borrow_mut_data()?;
    state[..8].copy_from_slice(EPOCH_MAGIC);state[8..40].copy_from_slice(funder.key.as_ref());state[40..72].copy_from_slice(&data[17..49]);
    put64(&mut state,72,id);put64(&mut state,80,total);put64(&mut state,88,0);put64(&mut state,96,creator);put64(&mut state,104,start);put64(&mut state,112,end);
    Ok(())
}

// data: tag(1), epoch_id(u64), amount(u64), proof_length(u8), proof nodes(32 each).
// A persistent bitmap costs rent once per wallet per 256-day page, not once daily.
fn claim(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len()<18 || data[17]>32 || data.len()!=18+usize::from(data[17])*32 || accounts.len()!=4 { return Err(ProgramError::InvalidInstructionData); }
    let mut iter=accounts.iter();let wallet=next_account_info(&mut iter)?;let epoch=next_account_info(&mut iter)?;
    let claims=next_account_info(&mut iter)?;let system=next_account_info(&mut iter)?;
    if !wallet.is_signer || !wallet.is_writable { return Err(ProgramError::MissingRequiredSignature); }
    if wallet.owner!=&system_program::id() || !epoch.is_writable || !claims.is_writable || system.key!=&system_program::id() { return Err(Error::InvalidState.into()); }
    let id=get64(data,1)?;let amount=get64(data,9)?;
    let id_bytes=id.to_le_bytes();let (expected,_)=Pubkey::find_program_address(&[b"rewards",MINT.as_ref(),&id_bytes],program);
    if epoch.key!=&expected || epoch.owner!=program { return Err(ProgramError::InvalidSeeds); }
    {
        let state=epoch.try_borrow_data()?;
        if state.len()!=EPOCH_LEN || &state[..8]!=EPOCH_MAGIC || get64(&state,72)?!=id || &state[8..40]!=FUNDER.as_ref() { return Err(Error::InvalidState.into()); }
        if amount==0 || !verify_proof(leaf(program,id,wallet.key,amount),&data[18..],&state[40..72]) { return Err(Error::InvalidProof.into()); }
        let next=get64(&state,88)?.checked_add(amount).ok_or(Error::Overflow)?;
        if next>get64(&state,80)? || epoch.lamports()<Rent::get()?.minimum_balance(EPOCH_LEN).checked_add(amount).ok_or(Error::Overflow)? { return Err(Error::Unfunded.into()); }
    }
    let claim_index=if id==BOOTSTRAP_ID {0} else {id.checked_add(1).ok_or(Error::Overflow)?};
    let page=claim_index/256;let page_bytes=page.to_le_bytes();let (expected,bump)=Pubkey::find_program_address(&[b"claims",MINT.as_ref(),wallet.key.as_ref(),&page_bytes],program);
    if claims.key!=&expected { return Err(ProgramError::InvalidSeeds); }
    if claims.owner==&system_program::id() {
        create_pda(wallet,claims,system,program,CLAIMS_LEN,&[b"claims",MINT.as_ref(),wallet.key.as_ref(),&page_bytes,&[bump]])?;
        let mut state=claims.try_borrow_mut_data()?;state[..8].copy_from_slice(CLAIM_MAGIC);state[8..40].copy_from_slice(wallet.key.as_ref());put64(&mut state,40,page);
    }
    let mut state=claims.try_borrow_mut_data()?;
    if claims.owner!=program || state.len()!=CLAIMS_LEN || &state[..8]!=CLAIM_MAGIC || &state[8..40]!=wallet.key.as_ref() || get64(&state,40)?!=page { return Err(Error::InvalidState.into()); }
    let index=48+(claim_index%256/8) as usize;let bit=1u8 << (claim_index%8);
    if state[index]&bit!=0 { return Err(Error::AlreadyClaimed.into()); }
    let receiver=wallet.lamports().checked_add(amount).ok_or(Error::Overflow)?;
    let mut epoch_state=epoch.try_borrow_mut_data()?;
    let claimed=get64(&epoch_state,88)?.checked_add(amount).ok_or(Error::Overflow)?;
    **epoch.try_borrow_mut_lamports()?-=amount;**wallet.try_borrow_mut_lamports()?=receiver;
    state[index]|=bit;put64(&mut epoch_state,88,claimed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_program_test::{processor,ProgramTest};
    use solana_sdk::{account::Account,instruction::{AccountMeta,Instruction},signature::{Keypair,Signer},transaction::Transaction};
    #[test] fn proofs_bind_wallet_amount_epoch_and_program() {
        let p=Pubkey::new_unique();let w=Pubkey::new_unique();let root=leaf(&p,0,&w,100);
        assert!(verify_proof(root,&[],&root));
        assert!(!verify_proof(leaf(&p,0,&w,101),&[],&root));
        assert!(!verify_proof(leaf(&p,1,&w,100),&[],&root));
        assert!(!verify_proof(leaf(&Pubkey::new_unique(),0,&w,100),&[],&root));
        assert!(!verify_proof(leaf(&p,0,&Pubkey::new_unique(),100),&[],&root));
        assert!(epoch_bounds(u64::MAX).is_err());
    }
    #[tokio::test] async fn funded_epoch_claim_and_replay_protection() {
        let program=Pubkey::new_unique();let funder=Keypair::new_from_array([7;32]);let wallet=Keypair::new();let attacker=Keypair::new();
        assert_eq!(funder.pubkey(),FUNDER);
        let mut test=ProgramTest::new("sub01_rewards",program,processor!(process_instruction));
        for key in [funder.pubkey(),wallet.pubkey(),attacker.pubkey()] {test.add_account(key,Account{lamports:10_000_000_000,owner:system_program::id(),..Account::default()});}
        let mut ctx=test.start_with_context().await;
        let mut clock=Clock::default();clock.unix_timestamp=(CUTOFF+DAY+1) as i64;ctx.set_sysvar(&clock);
        let epoch=Pubkey::find_program_address(&[b"rewards",MINT.as_ref(),&0u64.to_le_bytes()],&program).0;
        let root=leaf(&program,0,&wallet.pubkey(),200_000_000);
        let mut data=vec![0];data.extend_from_slice(&0u64.to_le_bytes());data.extend_from_slice(&1_000_000_000u64.to_le_bytes());data.extend_from_slice(&root);
        let publish=Instruction{program_id:program,accounts:vec![AccountMeta::new(funder.pubkey(),true),AccountMeta::new(epoch,false),AccountMeta::new_readonly(system_program::id(),false)],data};
        let block=ctx.banks_client.get_latest_blockhash().await.unwrap();
        ctx.banks_client.process_transaction(Transaction::new_signed_with_payer(&[publish.clone()],Some(&ctx.payer.pubkey()),&[&ctx.payer,&funder],block)).await.unwrap();
        let s=ctx.banks_client.get_account(epoch).await.unwrap().unwrap();assert_eq!(get64(&s.data,80).unwrap(),200_000_000);assert_eq!(s.owner,program);
        let mut changed=publish.clone();changed.data[17]^=1;
        assert!(ctx.banks_client.process_transaction(Transaction::new_signed_with_payer(&[changed],Some(&ctx.payer.pubkey()),&[&ctx.payer,&funder],block)).await.is_err());
        let make_claim=|who:Pubkey| {let claims=Pubkey::find_program_address(&[b"claims",MINT.as_ref(),who.as_ref(),&0u64.to_le_bytes()],&program).0;
            let mut data=vec![1];data.extend_from_slice(&0u64.to_le_bytes());data.extend_from_slice(&200_000_000u64.to_le_bytes());data.push(0);
            Instruction{program_id:program,accounts:vec![AccountMeta::new(who,true),AccountMeta::new(epoch,false),AccountMeta::new(claims,false),AccountMeta::new_readonly(system_program::id(),false)],data}};
        assert!(ctx.banks_client.process_transaction(Transaction::new_signed_with_payer(&[make_claim(attacker.pubkey())],Some(&ctx.payer.pubkey()),&[&ctx.payer,&attacker],block)).await.is_err());
        let before=ctx.banks_client.get_balance(wallet.pubkey()).await.unwrap();let claim=make_claim(wallet.pubkey());
        ctx.banks_client.process_transaction(Transaction::new_signed_with_payer(&[claim.clone()],Some(&ctx.payer.pubkey()),&[&ctx.payer,&wallet],block)).await.unwrap();
        let after=ctx.banks_client.get_balance(wallet.pubkey()).await.unwrap();assert_eq!(after-before,200_000_000-Rent::default().minimum_balance(CLAIMS_LEN));
        // Change compute budget so this is a fresh transaction, not a duplicate signature.
        let unique=solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(190_000);
        assert!(ctx.banks_client.process_transaction(Transaction::new_signed_with_payer(&[unique,claim],Some(&ctx.payer.pubkey()),&[&ctx.payer,&wallet],block)).await.is_err());
        assert_eq!(ctx.banks_client.get_balance(wallet.pubkey()).await.unwrap(),after);
        assert_eq!(get64(&ctx.banks_client.get_account(epoch).await.unwrap().unwrap().data,88).unwrap(),200_000_000);
        // Bootstrap can be published during the first day, and shares the first
        // bitmap with daily claims so it does not impose another rent deposit.
        let initial_epoch=Pubkey::find_program_address(&[b"rewards",MINT.as_ref(),&BOOTSTRAP_ID.to_le_bytes()],&program).0;
        let root=leaf(&program,BOOTSTRAP_ID,&wallet.pubkey(),200_000_000);
        let mut initial=vec![0];initial.extend_from_slice(&BOOTSTRAP_ID.to_le_bytes());initial.extend_from_slice(&1_000_000_000u64.to_le_bytes());initial.extend_from_slice(&root);initial.extend_from_slice(&(CUTOFF+1000).to_le_bytes());
        let instruction=Instruction{program_id:program,accounts:vec![AccountMeta::new(funder.pubkey(),true),AccountMeta::new(initial_epoch,false),AccountMeta::new_readonly(system_program::id(),false)],data:initial};
        ctx.banks_client.process_transaction(Transaction::new_signed_with_payer(&[instruction],Some(&ctx.payer.pubkey()),&[&ctx.payer,&funder],block)).await.unwrap();
        let bitmap=Pubkey::find_program_address(&[b"claims",MINT.as_ref(),wallet.pubkey().as_ref(),&0u64.to_le_bytes()],&program).0;
        let mut data=vec![1];data.extend_from_slice(&BOOTSTRAP_ID.to_le_bytes());data.extend_from_slice(&200_000_000u64.to_le_bytes());data.push(0);
        let instruction=Instruction{program_id:program,accounts:vec![AccountMeta::new(wallet.pubkey(),true),AccountMeta::new(initial_epoch,false),AccountMeta::new(bitmap,false),AccountMeta::new_readonly(system_program::id(),false)],data};
        let before=ctx.banks_client.get_balance(wallet.pubkey()).await.unwrap();
        ctx.banks_client.process_transaction(Transaction::new_signed_with_payer(&[instruction],Some(&ctx.payer.pubkey()),&[&ctx.payer,&wallet],block)).await.unwrap();
        assert_eq!(ctx.banks_client.get_balance(wallet.pubkey()).await.unwrap()-before,200_000_000);
        let state=ctx.banks_client.get_account(bitmap).await.unwrap().unwrap();assert_eq!(state.data[48]&3,3);
    }
    #[ignore = "Requires the built SBF artifact in BPF_OUT_DIR"]
    #[tokio::test] async fn deployed_binary_claim_smoke() {
        let program=Pubkey::new_unique();let wallet=Keypair::new();let mut state=vec![0u8;EPOCH_LEN];
        state[..8].copy_from_slice(EPOCH_MAGIC);state[8..40].copy_from_slice(pubkey!("HMPUiULXumamWDhuoKap6ty2hQ7V7GQwi8PZ7pGx6STQ").as_ref());
        state[40..72].copy_from_slice(&leaf(&program,0,&wallet.pubkey(),200_000_000));put64(&mut state,72,0);put64(&mut state,80,200_000_000);put64(&mut state,96,1_000_000_000);put64(&mut state,104,CUTOFF);put64(&mut state,112,CUTOFF+DAY);
        let epoch=Pubkey::find_program_address(&[b"rewards",MINT.as_ref(),&0u64.to_le_bytes()],&program).0;
        let bitmap=Pubkey::find_program_address(&[b"claims",MINT.as_ref(),wallet.pubkey().as_ref(),&0u64.to_le_bytes()],&program).0;
        let mut test=ProgramTest::new("sub01_rewards",program,None);test.prefer_bpf(true);
        test.add_account(wallet.pubkey(),Account{lamports:1_000_000_000,owner:system_program::id(),..Account::default()});
        test.add_account(epoch,Account{lamports:200_000_000+Rent::default().minimum_balance(EPOCH_LEN),owner:program,data:state,..Account::default()});
        let mut ctx=test.start_with_context().await;let block=ctx.banks_client.get_latest_blockhash().await.unwrap();
        let mut data=vec![1];data.extend_from_slice(&0u64.to_le_bytes());data.extend_from_slice(&200_000_000u64.to_le_bytes());data.push(0);
        let instruction=Instruction{program_id:program,accounts:vec![AccountMeta::new(wallet.pubkey(),true),AccountMeta::new(epoch,false),AccountMeta::new(bitmap,false),AccountMeta::new_readonly(system_program::id(),false)],data};
        let before=ctx.banks_client.get_balance(wallet.pubkey()).await.unwrap();
        ctx.banks_client.process_transaction(Transaction::new_signed_with_payer(&[instruction.clone()],Some(&ctx.payer.pubkey()),&[&ctx.payer,&wallet],block)).await.unwrap();
        assert_eq!(ctx.banks_client.get_balance(wallet.pubkey()).await.unwrap()-before,200_000_000-Rent::default().minimum_balance(CLAIMS_LEN));
        let unique=solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(185_000);
        assert!(ctx.banks_client.process_transaction(Transaction::new_signed_with_payer(&[unique,instruction],Some(&ctx.payer.pubkey()),&[&ctx.payer,&wallet],block)).await.is_err());
    }
}
