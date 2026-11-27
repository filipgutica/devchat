// GitHub's names: an owner of 1 to 39 letters, digits, and single inner hyphens, and a repo of 1 to
// 100 letters, digits, `.`, `_`, and `-`, other than `.` and `..`. No imports, so the web UI can use
// it without bundling zod.
export const githubRepoPattern = /^(?=[^/]{1,39}\/)[A-Za-z0-9](?:-?[A-Za-z0-9])*\/[A-Za-z0-9._-]{1,100}$/
export const isDotRepoName = (repo: string) => /\/\.{1,2}$/.test(repo)
export const isGithubRepo = (repo: string) => githubRepoPattern.test(repo) && !isDotRepoName(repo)
