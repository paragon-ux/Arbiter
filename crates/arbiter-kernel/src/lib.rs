use napi_derive::napi;

mod sandbox;
mod git_engine;

#[napi(object)]
pub struct WorktreeNativeResult {
    pub success: bool,
    pub worktree_path: String,
    pub branch: String,
    pub elapsed_us: i64,
}

#[napi(object)]
pub struct CommitNativeResult {
    pub success: bool,
    pub commit_id: String,
    pub elapsed_us: i64,
}

#[napi(object)]
pub struct PruneNativeResult {
    pub success: bool,
    pub elapsed_us: i64,
}

#[napi]
pub fn is_native_kernel_available() -> bool {
    true
}

#[napi]
pub fn kernel_create_job() -> napi::Result<i64> {
    sandbox::create_job().map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn kernel_assign_process(job_id: i64, pid: u32) -> napi::Result<bool> {
    sandbox::assign_process(job_id, pid).map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn kernel_terminate_job(job_id: i64, exit_code: Option<u32>) -> napi::Result<bool> {
    sandbox::terminate_job(job_id, exit_code.unwrap_or(1)).map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn kernel_close_job(job_id: i64) -> napi::Result<bool> {
    sandbox::close_job(job_id).map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub fn kernel_add_worktree(
    repo_path: String,
    name: String,
    path: String,
    branch_name: String,
    base_ref: Option<String>,
) -> napi::Result<WorktreeNativeResult> {
    let base = base_ref.unwrap_or_else(|| "HEAD".to_string());
    match git_engine::add_worktree(&repo_path, &name, &path, &branch_name, &base) {
        Ok(res) => Ok(WorktreeNativeResult {
            success: res.success,
            worktree_path: res.worktree_path,
            branch: res.branch,
            elapsed_us: res.elapsed_us as i64,
        }),
        Err(e) => Err(napi::Error::from_reason(e)),
    }
}

#[napi]
pub fn kernel_prune_worktree(
    repo_path: String,
    name: String,
    path: String,
) -> napi::Result<PruneNativeResult> {
    match git_engine::prune_worktree(&repo_path, &name, &path) {
        Ok(elapsed_us) => Ok(PruneNativeResult {
            success: true,
            elapsed_us: elapsed_us as i64,
        }),
        Err(e) => Err(napi::Error::from_reason(e)),
    }
}

#[napi]
pub fn kernel_stage_and_commit(
    worktree_path: String,
    message: String,
    author_name: String,
    author_email: String,
) -> napi::Result<CommitNativeResult> {
    match git_engine::stage_and_commit(&worktree_path, &message, &author_name, &author_email) {
        Ok(res) => Ok(CommitNativeResult {
            success: res.success,
            commit_id: res.commit_id,
            elapsed_us: res.elapsed_us as i64,
        }),
        Err(e) => Err(napi::Error::from_reason(e)),
    }
}

#[napi]
pub fn kernel_delete_branch(repo_path: String, branch_name: String) -> napi::Result<bool> {
    git_engine::delete_branch(&repo_path, &branch_name).map_err(|e| napi::Error::from_reason(e))
}

