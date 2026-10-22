// 프로젝트 폴더 후보 목록. 흔한 위치의 git 저장소 이름만 모은다(파일 내용은 읽지 않는다)
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const ROOTS: &[&str] = &[
    "", "PycharmProjects", "WebstormProjects", "IdeaProjects", "Documents", "Documents/GitHub", "projects", "Projects",
    "code", "dev", "workspace", "src", "repos", "git", "Desktop", "personal",
];
const LIMIT: usize = 300;

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && name != "node_modules" && name != "Library"
        })
        .map(|e| e.path())
        .collect();
    dirs.sort();
    dirs
}

// 워크트리는 .git 이 파일이라 폴더·파일 모두 저장소로 본다
fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

// 문제에 직접 적은 경로(~/… 또는 /…)
pub fn paths_in(text: &str, home: &Path) -> Vec<PathBuf> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"(?:^|[\s"'(「])((?:~|/)[^\s"'),」]+)"#).unwrap());
    re.captures_iter(text)
        .map(|c| {
            let raw = c[1].trim_end_matches(['.', ',']);
            match raw.strip_prefix('~') {
                Some(rest) => PathBuf::from(format!("{}{}", home.display(), rest)),
                None => PathBuf::from(raw),
            }
        })
        .filter(|p| p.is_dir())
        .collect()
}

pub fn list_projects(problem: &str, home: &Path) -> Vec<String> {
    let mut found: Vec<PathBuf> = paths_in(problem, home);
    let add = |p: PathBuf, found: &mut Vec<PathBuf>| {
        if found.len() < LIMIT && !found.contains(&p) {
            found.push(p)
        }
    };
    for root in ROOTS.iter().map(|r| home.join(r)).filter(|p| p.is_dir()) {
        for dir in subdirs(&root) {
            if is_repo(&dir) {
                add(dir, &mut found);
            } else {
                for inner in subdirs(&dir) {
                    if is_repo(&inner) {
                        add(inner, &mut found);
                    }
                }
            }
        }
    }
    found.into_iter().map(|p| p.display().to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 가짜 홈: git 저장소 둘, 일반 폴더 하나, node_modules 안 저장소 하나
    fn fake_home() -> PathBuf {
        let home = std::env::temp_dir().join(format!("home-{}", std::process::id()));
        for p in ["PycharmProjects/app-a/.git", "Documents/GitHub/org/app-b/.git", "PycharmProjects/notes", "projects/node_modules/x/.git"] {
            std::fs::create_dir_all(home.join(p)).unwrap();
        }
        home
    }

    #[test]
    fn collects_only_git_repos_in_common_places() {
        let home = fake_home();
        let list = list_projects("", &home);
        assert!(list.contains(&home.join("PycharmProjects/app-a").display().to_string()));
        assert!(list.contains(&home.join("Documents/GitHub/org/app-b").display().to_string()));
        assert!(!list.iter().any(|p| p.ends_with("notes") || p.contains("node_modules")));
    }

    #[test]
    fn paths_written_in_problem_are_candidates() {
        let home = fake_home();
        assert_eq!(paths_in("~/PycharmProjects/notes 구조를 봐줘. /no/such 는 무시", &home), vec![home.join("PycharmProjects/notes")]);
        assert!(list_projects("「~/PycharmProjects/notes」 봐줘", &home).contains(&home.join("PycharmProjects/notes").display().to_string()));
    }
}
