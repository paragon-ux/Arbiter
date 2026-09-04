use std::path::Path;
use std::time::Instant;
use git2::{Repository, WorktreeAddOptions, WorktreePruneOptions, IndexAddOption, Signature, build::CheckoutBuilder};

pub struct WorktreeAddOutput {
    pub success: bool,
    pub worktree_path: String,
    pub branch: String,
    pub elapsed_us: u64,
}

pub struct CommitOutput {
    pub success: bool,
    pub commit_id: String,
    pub elapsed_us: u64,
}

pub fn add_worktree(
    repo_path: &str,
    name: &str,
    path: &str,
    branch_name: &str,
    base_ref: &str,
) -> Result<WorktreeAddOutput, String> {
    let start = Instant::now();
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;

    let branch_ref = match repo.find_branch(branch_name, git2::BranchType::Local) {
        Ok(b) => b.into_reference(),
        Err(_) => {
            let base_obj = repo.revparse_single(base_ref)
                .map_err(|e| format!("Base ref '{}' not found: {}", base_ref, e))?;
            let base_commit = base_obj.peel_to_commit()
                .map_err(|e| format!("Base ref '{}' does not resolve to a commit: {}", base_ref, e))?;
            let b = repo.branch(branch_name, &base_commit, false)
                .map_err(|e| format!("Failed to create branch '{}': {}", branch_name, e))?;
            b.into_reference()
        }
    };

    let mut opts = WorktreeAddOptions::new();
    opts.reference(Some(&branch_ref));

    let dest = Path::new(path);
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let wt = repo.worktree(name, dest, Some(&opts))
        .map_err(|e| format!("Failed to add worktree: {}", e))?;

    // Check out files into worktree directory
    let wt_repo = Repository::open_from_worktree(&wt)
        .map_err(|e| format!("Failed to open repo from worktree: {}", e))?;
    let mut checkout_builder = CheckoutBuilder::new();
    checkout_builder.force();
    wt_repo.checkout_head(Some(&mut checkout_builder))
        .map_err(|e| format!("Failed to checkout worktree head: {}", e))?;

    let elapsed = start.elapsed().as_micros() as u64;
    Ok(WorktreeAddOutput {
        success: true,
        worktree_path: wt.path().to_string_lossy().to_string(),
        branch: branch_name.to_string(),
        elapsed_us: elapsed,
    })
}

pub fn prune_worktree(repo_path: &str, name: &str, path: &str) -> Result<u64, String> {
    let start = Instant::now();
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;

    if let Ok(wt) = repo.find_worktree(name) {
        let mut opts = WorktreePruneOptions::new();
        opts.valid(true);
        let _ = wt.prune(Some(&mut opts));
    }

    let p = Path::new(path);
    if p.exists() {
        let _ = std::fs::remove_dir_all(p);
    }

    Ok(start.elapsed().as_micros() as u64)
}

pub fn stage_and_commit(
    worktree_path: &str,
    message: &str,
    author_name: &str,
    author_email: &str,
) -> Result<CommitOutput, String> {
    let start = Instant::now();
    let repo = Repository::open(worktree_path).map_err(|e| format!("Failed to open worktree repo: {}", e))?;

    let mut index = repo.index().map_err(|e| format!("Failed to get index: {}", e))?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Failed to add files to index: {}", e))?;
    index.write().map_err(|e| format!("Failed to write index: {}", e))?;

    let tree_id = index.write_tree().map_err(|e| format!("Failed to write tree: {}", e))?;
    let tree = repo.find_tree(tree_id).map_err(|e| format!("Failed to find tree: {}", e))?;

    let sig = Signature::now(author_name, author_email)
        .map_err(|e| format!("Failed to create signature: {}", e))?;

    let parent = match repo.head() {
        Ok(head) => match head.peel_to_commit() {
            Ok(c) => Some(c),
            Err(_) => None,
        },
        Err(_) => None,
    };

    let parents = match &parent {
        Some(p) => vec![p],
        None => vec![],
    };

    let commit_id = repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        message,
        &tree,
        &parents,
    ).map_err(|e| format!("Failed to create commit: {}", e))?;

    Ok(CommitOutput {
        success: true,
        commit_id: commit_id.to_string(),
        elapsed_us: start.elapsed().as_micros() as u64,
    })
}
