export async function importIssue(url: unknown) {
  const match =
    typeof url === 'string' &&
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/.exec(
      url.trim(),
    )
  if (!match || match.slice(1, 3).some((s) => s === '.' || s === '..'))
    throw Error('请输入公开 github.com 仓库的 Issue 链接，或直接粘贴正文')
  const [, owner, repo, id] = match
  const response = await fetch(
    'https://api.github.com/repos/' + owner + '/' + repo + '/issues/' + id,
    {
      redirect: 'error',
      headers: {
        'User-Agent': 'Mini-Agent-Doctor',
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(12000),
    },
  )
  if (!response.ok)
    throw Error(
      '读取 GitHub Issue 失败 HTTP ' +
        response.status +
        '，可直接粘贴标题与正文',
    )
  const data = await response.json()
  if (data.pull_request || typeof data.title !== 'string')
    throw Error('链接没有指向 Issue')
  return {
    question: (
      data.title +
      '\n' +
      url +
      '\n\n' +
      String(data.body ?? '')
    ).slice(0, 12000),
  }
}
