use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// Canonicalize a path, stripping the Windows extended-length prefix (`\\?\`)
/// when the result is a simple drive-letter path (e.g. `C:\...`). This keeps
/// paths compatible with shell APIs (`ShellExecuteW`) that reject `\\?\`.
///
/// Every path the resolver returns carries this spelling, so any caller that
/// compares a resolved path against a root must canonicalize that root the
/// same way — std `Path::canonicalize` keeps the `\\?\` prefix on Windows and
/// would never match.
pub(crate) fn simple_canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = path.canonicalize()?;
    #[cfg(windows)]
    {
        Ok(strip_windows_extended_drive_prefix(&canonical))
    }
    #[cfg(not(windows))]
    {
        Ok(canonical)
    }
}

#[cfg(windows)]
fn strip_windows_extended_drive_prefix(path: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::Prefix;

    if matches!(path.components().next(), Some(Component::Prefix(prefix))
        if matches!(prefix.kind(), Prefix::VerbatimDisk(_)))
    {
        // Only drive paths lose the prefix; verbatim UNC/device paths keep it.
        let wide: Vec<_> = path.as_os_str().encode_wide().skip(4).collect();
        return PathBuf::from(OsString::from_wide(&wide));
    }
    path.to_path_buf()
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct WorkspaceState {
    pub path: Option<String>,
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<crate::db::RemoteWorkspace>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectWorkspace {
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<crate::db::RemoteWorkspace>,
}

impl WorkspaceState {
    pub fn get(&self) -> Option<ProjectWorkspace> {
        match (&self.path, &self.name) {
            (Some(path), Some(name)) => Some(ProjectWorkspace {
                path: path.clone(),
                name: name.clone(),
                remote: self.remote.clone(),
            }),
            _ => None,
        }
    }

    pub fn set_remote(&mut self, project: &crate::db::ProjectGroupRecord) -> ProjectWorkspace {
        self.path = Some(project.primary_path.clone());
        self.name = Some(project.name.clone());
        self.remote = project.remote.clone();
        ProjectWorkspace {
            path: project.primary_path.clone(),
            name: project.name.clone(),
            remote: project.remote.clone(),
        }
    }

    pub fn set(&mut self, path: impl AsRef<Path>) -> ProjectWorkspace {
        let path =
            simple_canonicalize(path.as_ref()).unwrap_or_else(|_| path.as_ref().to_path_buf());
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("workspace")
            .to_string();
        let path_str = path.to_string_lossy().to_string();
        self.remote = None;
        self.path = Some(path_str.clone());
        self.name = Some(name.clone());
        ProjectWorkspace {
            path: path_str,
            name,
            remote: None,
        }
    }

    pub fn clear(&mut self) {
        self.path = None;
        self.name = None;
        self.remote = None;
    }
}

/// Which containment root a tool path resolved into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRoot {
    Workspace,
    Scratch,
    /// Per-session GenUI fragment directory (D671).
    Visualization,
    External,
}

/// A host-owned directory a session may address by absolute path in addition
/// to its workspace. Every contained root gets the same lexical + symlink
/// containment defense as the workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainedRoot {
    pub path: PathBuf,
    pub kind: ToolRoot,
}

impl ContainedRoot {
    /// Root identity is rechecked at authorization and execution, not cached
    /// when the session starts. Scratch retains its existing D114 semantics.
    pub fn allows_implicit_access(&self) -> bool {
        self.kind != ToolRoot::Visualization
            || crate::visualizations::validate_session_root(&self.path).is_ok()
    }

    fn lexically_contains(&self, input: &str) -> bool {
        if self.kind == ToolRoot::Visualization {
            crate::visualizations::contains_session_path(&self.path, input)
        } else {
            lexically_inside(&self.path, input)
        }
    }
}

/// Ordered contained roots checked before workspace fallback. The first root
/// that claims a path must validate its current identity before granting access.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContainedRoots {
    roots: Vec<ContainedRoot>,
}

impl ContainedRoots {
    pub fn new() -> Self {
        Self::default()
    }

    /// Roots holding only the session scratch directory (D114), if any.
    pub fn scratch_only(scratch: Option<&Path>) -> Self {
        Self::new().with(ToolRoot::Scratch, scratch.map(Path::to_path_buf))
    }

    /// Append a root; `None` leaves the list unchanged.
    pub fn with(mut self, kind: ToolRoot, path: Option<PathBuf>) -> Self {
        if let Some(path) = path {
            self.roots.push(ContainedRoot { path, kind });
        }
        self
    }

    pub fn iter(&self) -> impl Iterator<Item = &ContainedRoot> {
        self.roots.iter()
    }

    /// First claimed root (absolute paths only), including visualization data
    /// aliases. Claiming a root does not grant access: check its current validity.
    pub fn lexical_root(&self, input: &str) -> Option<&ContainedRoot> {
        self.roots
            .iter()
            .find(|root| root.lexically_contains(input))
    }
}

/// Lexically resolve `.` / `..` components without touching the filesystem.
/// `..` at the filesystem root clamps (stays at root); the caller's
/// starts_with check then rejects anything that climbed out of the workspace.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Normalize containment spelling without resolving user-controlled symlinks.
/// Windows expands drive-path 8.3 names; macOS expands only the OS-owned
/// /var and /tmp aliases. Missing tails and normal link-escape checks remain.
fn normalize_containment_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    let path = strip_windows_extended_drive_prefix(path);
    let normalized = normalize_lexical(path.as_ref());
    #[cfg(target_os = "macos")]
    let normalized = {
        let mut expanded = normalized.clone();
        for alias in ["/var", "/tmp"] {
            if let Ok(tail) = normalized.strip_prefix(alias) {
                if let Ok(canonical) = std::fs::canonicalize(alias) {
                    expanded = canonical.join(tail);
                }
                break;
            }
        }
        expanded
    };
    #[cfg(not(windows))]
    {
        normalized
    }

    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use std::path::Prefix;
        use windows_sys::Win32::Storage::FileSystem::GetLongPathNameW;

        // Keep UNC/device semantics unchanged and avoid probing a network path
        // before the lexical boundary has authorized it.
        if !normalized.is_absolute()
            || !matches!(normalized.components().next(), Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_)))
        {
            return normalized;
        }

        // Never let a Win32 string terminator truncate an untrusted path.
        if normalized.as_os_str().encode_wide().any(|unit| unit == 0) {
            return normalized;
        }
        let mut existing = normalized.clone();
        let mut tail = Vec::new();
        loop {
            // Retain support for paths longer than MAX_PATH during lookup.
            let wide: Vec<_> = r"\\?\"
                .encode_utf16()
                .chain(existing.as_os_str().encode_wide())
                .chain(Some(0))
                .collect();
            // SAFETY: input is NUL-terminated; the first call only sizes output.
            let required = unsafe { GetLongPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
            if required > 0 {
                let mut buffer = vec![0; required as usize];
                // SAFETY: output has the advertised capacity in UTF-16 units.
                let written =
                    unsafe { GetLongPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), required) };
                if written > 0 && written < required {
                    let mut expanded =
                        PathBuf::from(OsString::from_wide(&buffer[..written as usize]));
                    for part in tail.iter().rev() {
                        expanded.push(part);
                    }
                    return strip_windows_extended_drive_prefix(&expanded);
                }
            }
            // Missing/inaccessible entries (or a sizing race) must not cause
            // canonicalization to replace our lexical containment check.
            match (existing.parent(), existing.file_name()) {
                (Some(parent), Some(name)) => {
                    tail.push(name.to_os_string());
                    existing = parent.to_path_buf();
                }
                _ => return normalized,
            }
        }
    }
}

/// Compare path components using the platform's filesystem semantics.
/// Windows paths are case-insensitive even though `Path` comparisons are not.
fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let root_components: Vec<_> = root.components().collect();
    let candidate_components: Vec<_> = candidate.components().collect();
    root_components.len() <= candidate_components.len()
        && root_components
            .iter()
            .zip(candidate_components.iter())
            .all(|(root, candidate)| {
                #[cfg(windows)]
                {
                    root.as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&candidate.as_os_str().to_string_lossy())
                }
                #[cfg(not(windows))]
                {
                    root == candidate
                }
            })
}

/// Upper bound on dangling-symlink hops the resolver follows before giving up.
const MAX_DANGLING_LINK_HOPS: usize = 32;

/// Resolve a normalized path by canonicalizing its deepest existing ancestor.
/// The same resolver is used for contained and explicitly approved paths so
/// symlink behavior does not change when a permission card is accepted.
///
/// Existence is probed with `symlink_metadata`, not `exists()`: a dangling
/// symlink reports "missing" through `exists()` and would otherwise be treated
/// as a not-yet-created leaf whose parent canonicalizes fine, while a later
/// write follows the link and creates its target wherever it points. Instead
/// the link target is read and resolution restarts from it so the caller's
/// containment check sees the real destination.
fn resolve_with_existing_ancestor(normalized: PathBuf) -> Result<PathBuf, String> {
    let mut current = normalized;
    for _ in 0..MAX_DANGLING_LINK_HOPS {
        let mut existing = current;
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        while existing.symlink_metadata().is_err() {
            match (existing.parent(), existing.file_name()) {
                (Some(parent), Some(name)) => {
                    tail.push(name.to_os_string());
                    existing = parent.to_path_buf();
                }
                _ => break,
            }
        }
        let is_dangling_link = existing
            .symlink_metadata()
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
            && !existing.exists();
        if is_dangling_link {
            let target = std::fs::read_link(&existing)
                .map_err(|e| format!("path canonicalize failed: {e}"))?;
            let base = existing
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("/"));
            let mut next = if target.is_absolute() {
                target
            } else {
                base.join(target)
            };
            for part in tail.iter().rev() {
                next.push(part);
            }
            current = normalize_lexical(&next);
            continue;
        }
        let mut resolved =
            simple_canonicalize(&existing).map_err(|e| format!("path canonicalize failed: {e}"))?;
        for part in tail.iter().rev() {
            resolved.push(part);
        }
        return Ok(resolved);
    }
    Err("path canonicalize failed: too many symlink hops".into())
}

/// Resolve a user-provided path against workspace root and ensure it stays inside.
///
/// Two layers of defense:
/// 1. Lexical normalization of `.`/`..` and Windows name spelling before any
///    check, so traversal via nonexistent parents cannot hide behind an
///    uncanonicalizable path. Name expansion does not resolve symlinks.
/// 2. Canonicalization of the deepest existing ancestor, so symlinks inside
///    the workspace cannot smuggle a target outside it.
pub fn resolve_in_workspace(workspace_root: &Path, input: &str) -> Result<PathBuf, String> {
    let root = simple_canonicalize(workspace_root)
        .map_err(|e| format!("workspace canonicalize failed: {e}"))?;
    let candidate = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        root.join(input)
    };

    let normalized = normalize_containment_path(&candidate);
    if !path_is_within(&root, &normalized) {
        return Err("PATH_OUTSIDE_WORKSPACE".into());
    }

    // Canonicalize the deepest existing ancestor (resolves symlinks), then
    // re-append the not-yet-existing tail.
    let resolved = resolve_with_existing_ancestor(normalized)?;

    if !path_is_within(&root, &resolved) {
        return Err("PATH_OUTSIDE_WORKSPACE".into());
    }
    Ok(resolved)
}

/// Resolve an explicitly approved path without applying workspace
/// containment. Relative paths still use the session workspace as their base;
/// only the permission decision can opt a tool into this resolver.
pub fn resolve_external_path(workspace_root: &Path, input: &str) -> Result<PathBuf, String> {
    let root = simple_canonicalize(workspace_root)
        .map_err(|e| format!("workspace canonicalize failed: {e}"))?;
    let candidate = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        root.join(input)
    };
    resolve_with_existing_ancestor(normalize_lexical(&candidate))
}

/// Resolve a tool path against the workspace root, falling back to the
/// session's contained roots in order (scratch per D114, visualizations).
/// Relative paths always resolve against the workspace; contained roots are
/// addressed by absolute path only (the model learns them from the system
/// prompt). Every root gets the same lexical + symlink containment defense.
pub fn resolve_tool_path(
    workspace_root: &Path,
    roots: &ContainedRoots,
    input: &str,
) -> Result<(PathBuf, ToolRoot), String> {
    // A contained root is more specific than the workspace: when a workspace
    // happens to contain the data directory (for example `$HOME`), a path
    // spelled inside a contained root must still resolve against that root so
    // its own containment and write rules apply.
    if let Some(root) = roots.lexical_root(input) {
        return resolve_in_contained_root(root, input)
            .map(|path| (path, root.kind))
            .ok_or_else(|| "PATH_OUTSIDE_WORKSPACE".to_string());
    }
    let workspace_err = match resolve_in_workspace(workspace_root, input) {
        Ok(path) => return Ok((path, ToolRoot::Workspace)),
        Err(e) => e,
    };
    if Path::new(input).is_absolute() {
        for root in roots.iter() {
            if let Some(path) = resolve_in_contained_root(root, input) {
                return Ok((path, root.kind));
            }
        }
    }
    Err(workspace_err)
}

fn resolve_in_contained_root(root: &ContainedRoot, input: &str) -> Option<PathBuf> {
    if !root.allows_implicit_access() {
        return None;
    }
    if let Ok(path) = resolve_in_workspace(&root.path, input) {
        return Some(path);
    }
    // The model addresses a root with the exact spelling we advertised, which
    // may differ from the canonical one (macOS /var vs /private/var, /tmp vs
    // /private/tmp). Rewrite a literal root prefix to a relative path and
    // resolve that — the full containment defense still runs.
    let candidate = normalize_lexical(Path::new(input));
    let rel = candidate.strip_prefix(normalize_lexical(&root.path)).ok()?;
    resolve_in_workspace(&root.path, &rel.to_string_lossy()).ok()
}

/// Resolve a tool path after the host has granted explicit outside-workspace
/// access for this call. Workspace and contained-root paths keep their
/// normal roots; only an otherwise rejected path becomes `External`.
pub fn resolve_tool_path_with_external(
    workspace_root: &Path,
    roots: &ContainedRoots,
    input: &str,
    allow_external: bool,
) -> Result<(PathBuf, ToolRoot), String> {
    match resolve_tool_path(workspace_root, roots, input) {
        Ok(result) => Ok(result),
        Err(error) if allow_external && error == "PATH_OUTSIDE_WORKSPACE" => Ok((
            resolve_external_path(workspace_root, input)?,
            ToolRoot::External,
        )),
        Err(error) => Err(error),
    }
}

/// Lexical containment check (including Windows name spelling): does `input`
/// (absolute) normalize to a path under `root`? Used to decide whether a scratch
/// write can skip the permission prompt — execution still runs the full
/// symlink-aware resolver, so a false positive here cannot escape containment.
pub fn lexically_inside(root: &Path, input: &str) -> bool {
    let candidate = Path::new(input);
    if !candidate.is_absolute() {
        return false;
    }
    path_is_within(
        &normalize_containment_path(root),
        &normalize_containment_path(candidate),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn scratch_roots(scratch: &Path) -> ContainedRoots {
        ContainedRoots::scratch_only(Some(scratch))
    }

    #[test]
    fn blocks_escape() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "x").unwrap();
        let err = resolve_in_workspace(root, "../outside.txt").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn blocks_escape_via_nonexistent_parent() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // `sub` does not exist; lexical traversal must still be caught.
        let err = resolve_in_workspace(root, "sub/../../evil/new.txt").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
        let err = resolve_in_workspace(root, "a/b/../../../evil.txt").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn blocks_absolute_outside() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let err = resolve_in_workspace(root, "/etc/hosts").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn allows_new_nested_path() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let p = resolve_in_workspace(root, "newdir/sub/file.txt").unwrap();
        assert!(p.starts_with(simple_canonicalize(root).unwrap()));
        assert!(p.ends_with("newdir/sub/file.txt"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_system_alias_preserves_workspace_identity_and_blocks_link_escape() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let root = simple_canonicalize(dir.path()).unwrap();
        let alias = dir.path().join("new.txt");
        let (resolved, kind) = resolve_tool_path_with_external(
            &root,
            &ContainedRoots::new(),
            &alias.to_string_lossy(),
            true,
        )
        .unwrap();
        assert_eq!(kind, ToolRoot::Workspace);
        assert_eq!(resolved, root.join("new.txt"));
        assert!(lexically_inside(&root, &alias.to_string_lossy()));
        let outside = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        assert_eq!(
            resolve_in_workspace(&root, &dir.path().join("escape/new.txt").to_string_lossy())
                .unwrap_err(),
            "PATH_OUTSIDE_WORKSPACE"
        );
    }

    #[cfg(unix)]
    #[test]
    fn blocks_symlink_escape() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let root = dir.path();
        std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
        let err = resolve_in_workspace(root, "link/new.txt").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[cfg(unix)]
    #[test]
    fn blocks_dangling_symlink_escape() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let root = dir.path();
        // The target does not exist yet: `exists()` says false for the link,
        // but a write through it would create the file outside the workspace.
        let target = outside.path().join("planted.txt");
        std::os::unix::fs::symlink(&target, root.join("dangling")).unwrap();
        let err = resolve_in_workspace(root, "dangling").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
        assert!(!target.exists());

        // A dangling link to a directory that would be created outside.
        std::os::unix::fs::symlink(outside.path().join("dir"), root.join("dangling-dir")).unwrap();
        let err = resolve_in_workspace(root, "dangling-dir/new.txt").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlink_inside_workspace_resolves_to_its_target() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        std::os::unix::fs::symlink(root.join("not-yet.txt"), root.join("dangling")).unwrap();
        let resolved = resolve_in_workspace(root, "dangling").unwrap();
        assert_eq!(
            resolved,
            simple_canonicalize(root).unwrap().join("not-yet.txt")
        );

        // Relative link targets resolve against the link's own directory.
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::os::unix::fs::symlink("../elsewhere.txt", root.join("sub/rel")).unwrap();
        let resolved = resolve_in_workspace(root, "sub/rel").unwrap();
        assert_eq!(
            resolved,
            simple_canonicalize(root).unwrap().join("elsewhere.txt")
        );
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlink_loop_is_rejected() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        std::os::unix::fs::symlink(root.join("b"), root.join("a")).unwrap();
        std::os::unix::fs::symlink(root.join("a"), root.join("b")).unwrap();
        let err = resolve_in_workspace(root, "a").unwrap_err();
        assert!(err.contains("too many symlink hops"), "{err}");
    }

    #[test]
    fn tool_path_relative_resolves_to_workspace() {
        let ws = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let (p, root) =
            resolve_tool_path(ws.path(), &scratch_roots(scratch.path()), "notes.txt").unwrap();
        assert_eq!(root, ToolRoot::Workspace);
        assert!(p.starts_with(simple_canonicalize(ws.path()).unwrap()));
    }

    #[test]
    fn tool_path_absolute_scratch_resolves_to_scratch() {
        let ws = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let input = scratch.path().join("tmp.json");
        let (p, root) = resolve_tool_path(
            ws.path(),
            &scratch_roots(scratch.path()),
            input.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(root, ToolRoot::Scratch);
        assert!(p.starts_with(simple_canonicalize(scratch.path()).unwrap()));
    }

    #[test]
    fn tool_path_escape_from_scratch_blocked() {
        let ws = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let input = scratch.path().join("a/../../evil.txt");
        let err = resolve_tool_path(
            ws.path(),
            &scratch_roots(scratch.path()),
            input.to_str().unwrap(),
        )
        .unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[cfg(unix)]
    #[test]
    fn tool_path_symlink_escape_from_scratch_blocked() {
        let ws = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), scratch.path().join("link")).unwrap();
        let input = scratch.path().join("link/new.txt");
        let err = resolve_tool_path(
            ws.path(),
            &scratch_roots(scratch.path()),
            input.to_str().unwrap(),
        )
        .unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn tool_path_absolute_outside_both_roots_blocked() {
        let ws = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let err =
            resolve_tool_path(ws.path(), &scratch_roots(scratch.path()), "/etc/hosts").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn approved_external_path_resolves_and_keeps_absolute_identity() {
        let ws = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let input = outside.path().join("outside.txt");
        fs::write(&input, "outside").unwrap();

        let (resolved, root) = resolve_tool_path_with_external(
            ws.path(),
            &ContainedRoots::new(),
            input.to_str().unwrap(),
            true,
        )
        .unwrap();
        assert_eq!(root, ToolRoot::External);
        assert_eq!(resolved, simple_canonicalize(&input).unwrap());
    }

    #[test]
    fn relative_escape_can_be_resolved_only_after_external_approval() {
        let parent = tempdir().unwrap();
        let ws = parent.path().join("workspace");
        let outside = parent.path().join("outside.txt");
        fs::create_dir_all(&ws).unwrap();
        fs::write(&outside, "outside").unwrap();

        let input = "../outside.txt";
        assert_eq!(
            resolve_tool_path(&ws, &ContainedRoots::new(), input).unwrap_err(),
            "PATH_OUTSIDE_WORKSPACE"
        );
        let (resolved, root) =
            resolve_tool_path_with_external(&ws, &ContainedRoots::new(), input, true).unwrap();
        assert_eq!(root, ToolRoot::External);
        assert_eq!(resolved, simple_canonicalize(&outside).unwrap());
    }

    #[test]
    fn lexically_inside_checks() {
        let dir = tempdir().unwrap();
        let data = dir.path().join("data");
        let root = data.join("scratch").join("s1");
        let inside = root.join("a.txt");
        let normalized_inside = root.join("sub").join(".").join("b.txt");
        let sibling = root.join("..").join("s2").join("a.txt");
        let other = data.join("other").join("a.txt");

        assert!(lexically_inside(&root, inside.to_str().unwrap()));
        assert!(lexically_inside(&root, normalized_inside.to_str().unwrap()));
        assert!(!lexically_inside(&root, sibling.to_str().unwrap()));
        assert!(!lexically_inside(&root, other.to_str().unwrap()));
        assert!(!lexically_inside(&root, "relative/a.txt"));
    }

    #[test]
    fn allows_inside() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "x").unwrap();
        let p = resolve_in_workspace(root, "a.txt").unwrap();
        assert!(p.ends_with("a.txt"));
    }

    #[cfg(windows)]
    mod windows {
        use super::*;
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

        fn short_path(path: &Path) -> PathBuf {
            let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            // SAFETY: input is NUL-terminated; output is sized by the first call.
            let required = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
            assert!(required > 0, "{}", std::io::Error::last_os_error());
            let mut buffer = vec![0; required as usize];
            // SAFETY: the buffer holds `required` UTF-16 units.
            let written =
                unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), required) };
            assert!(written > 0 && written < required);
            let short = PathBuf::from(OsString::from_wide(&buffer[..written as usize]));
            if short == path {
                // Volumes may disable 8.3 creation. Still exercise real API
                // output and verbatim/case spellings rather than skip the test.
                eprintln!(
                    "No short alias for {}; testing its returned spelling",
                    path.display()
                );
            }
            short
        }

        fn verbatim(path: &Path) -> PathBuf {
            assert!(
                matches!(path.components().next(), Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
            );
            let mut spelling = OsString::from(r"\\?\");
            spelling.push(path);
            PathBuf::from(spelling)
        }

        #[test]
        fn short_and_verbatim_workspace_paths_keep_workspace_identity() {
            let dir = tempdir().unwrap();
            let root = dir.path().join("Workspace long spelling");
            fs::create_dir(&root).unwrap();
            let root = simple_canonicalize(&root).unwrap();
            let file = root.join("Existing long file.txt");
            fs::write(&file, "inside").unwrap();
            let short_root = short_path(&root);
            let roots = [root.clone(), short_root.clone(), verbatim(&short_root)];
            let cases = [
                (short_path(&file), file),
                (
                    short_root.join(r"Missing directory\nested\new.txt"),
                    root.join(r"Missing directory\nested\new.txt"),
                ),
            ];
            for (input, expected) in cases {
                for spelling in [
                    input.clone(),
                    verbatim(&input),
                    PathBuf::from(input.to_str().unwrap().to_ascii_uppercase()),
                ] {
                    for workspace in &roots {
                        assert!(lexically_inside(workspace, spelling.to_str().unwrap()));
                        let (resolved, kind) = resolve_tool_path_with_external(
                            workspace,
                            &ContainedRoots::new(),
                            spelling.to_str().unwrap(),
                            true,
                        )
                        .unwrap();
                        assert_eq!(kind, ToolRoot::Workspace, "{}", spelling.display());
                        // The not-yet-existing tail retains the caller's case.
                        assert!(path_is_within(&expected, &resolved));
                        assert!(path_is_within(&resolved, &expected));
                    }
                }
            }
        }

        #[test]
        fn short_and_verbatim_siblings_and_traversal_stay_outside() {
            let dir = tempdir().unwrap();
            let root = dir.path().join("Workspace long spelling");
            let sibling = dir.path().join("Workspace long spelling sibling");
            fs::create_dir(&root).unwrap();
            fs::create_dir(&sibling).unwrap();
            fs::write(sibling.join("exists.txt"), "outside").unwrap();
            let root = simple_canonicalize(&root).unwrap();
            for input in [
                short_path(&sibling).join("exists.txt"),
                short_path(&sibling).join("new.txt"),
                short_path(&root).join(r"missing\..\..\outside.txt"),
            ] {
                for spelling in [input.clone(), verbatim(&input)] {
                    let input = spelling.to_str().unwrap();
                    assert!(!lexically_inside(&root, input));
                    assert_eq!(
                        resolve_in_workspace(&root, input).unwrap_err(),
                        "PATH_OUTSIDE_WORKSPACE"
                    );
                }
            }
        }

        #[test]
        fn short_contained_paths_keep_priority_over_enclosing_workspace() {
            let dir = tempdir().unwrap();
            let workspace = simple_canonicalize(dir.path()).unwrap();
            let scratch = workspace.join("Scratch long spelling");
            let visualization = workspace.join(r"Host data long spelling\visualizations\session1");
            fs::create_dir(&scratch).unwrap();
            fs::create_dir_all(&visualization).unwrap();
            let roots =
                scratch_roots(&scratch).with(ToolRoot::Visualization, Some(visualization.clone()));
            for (root, kind) in [
                (scratch, ToolRoot::Scratch),
                (visualization, ToolRoot::Visualization),
            ] {
                let input = short_path(&root).join("new.html");
                for spelling in [input.clone(), verbatim(&input)] {
                    let input = spelling.to_str().unwrap();
                    assert_eq!(roots.lexical_root(input).unwrap().kind, kind);
                    let (resolved, actual) = resolve_tool_path(&workspace, &roots, input).unwrap();
                    assert_eq!(actual, kind);
                    assert_eq!(resolved, root.join("new.html"));
                }
            }
        }

        fn junction(link: &Path, target: &Path) {
            // Like the visualization tests, use junctions: no symlink privilege
            // is needed, and raw_arg keeps cmd's quoting intact.
            let output = std::process::Command::new("cmd.exe")
                .args(["/D", "/V:OFF", "/C"])
                .raw_arg(format!(
                    "mklink /J \"{}\" \"{}\"",
                    link.display(),
                    target.display()
                ))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "junction creation failed: {output:?}"
            );
        }

        #[test]
        fn spelling_expansion_does_not_admit_junctions_in_either_direction() {
            let dir = tempdir().unwrap();
            let base = simple_canonicalize(dir.path()).unwrap();
            let root = base.join("Workspace long spelling");
            let outside = base.join("Outside long spelling");
            fs::create_dir(&root).unwrap();
            fs::create_dir(&outside).unwrap();
            fs::write(root.join("exists.txt"), "inside").unwrap();
            fs::write(outside.join("exists.txt"), "outside").unwrap();
            let outgoing = root.join("Outgoing link");
            let incoming = outside.join("Incoming link");
            junction(&outgoing, &outside);
            junction(&incoming, &root);
            for (link, lexical_inside) in [(outgoing, true), (incoming, false)] {
                for leaf in ["exists.txt", r"missing\new.txt"] {
                    let input = short_path(&link).join(leaf);
                    for spelling in [input.clone(), verbatim(&input)] {
                        let input = spelling.to_str().unwrap();
                        assert_eq!(lexically_inside(&root, input), lexical_inside);
                        assert_eq!(
                            resolve_in_workspace(&root, input).unwrap_err(),
                            "PATH_OUTSIDE_WORKSPACE"
                        );
                        let (_, kind) = resolve_tool_path_with_external(
                            &root,
                            &ContainedRoots::new(),
                            input,
                            true,
                        )
                        .unwrap();
                        assert_eq!(kind, ToolRoot::External);
                    }
                }
                fs::remove_dir(link).unwrap();
            }
        }

        #[test]
        fn extended_drive_normalization_keeps_unc_and_device_prefixes() {
            assert_eq!(
                strip_windows_extended_drive_prefix(Path::new(r"\\?\C:\workspace\file")),
                PathBuf::from(r"C:\workspace\file")
            );
            for spelling in [
                r"\\?\UNC\server\share\file",
                r"\\server\share\file",
                r"\\.\device",
            ] {
                assert_eq!(
                    strip_windows_extended_drive_prefix(Path::new(spelling)),
                    PathBuf::from(spelling)
                );
            }
        }
    }
}
