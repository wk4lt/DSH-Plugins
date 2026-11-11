const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

function ensurePrivateSshConfig(root) {
  const file = path.join(root, 'ssh_config')
  mkdirSync(root, { recursive: true })
  try {
    writeFileSync(file, '# OpenSSH options for dsh-remote\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return file
}

function sshOptionValue(value) {
  return '"' + String(value).replace(/"/g, '\\$&') + '"'
}

function sshConnectionArgs(config) {
  const args = []
  if (config.sshConfigFile) args.push('-F', config.sshConfigFile)
  const hostname = config.pinnedHost || (config.sshConfigFile && config.host)
  if (hostname) args.push('-o', 'HostName=' + hostname)
  if (config.port) args.push('-p', String(Number(config.port)))
  if (config.username) args.push('-l', String(config.username))
  if (config.privateKeyPath) args.push('-i', String(config.privateKeyPath))
  if (config.agentSocket) args.push('-o', 'IdentityAgent=' + sshOptionValue(config.agentSocket))
  if (config.identitiesOnly) args.push('-o', 'IdentitiesOnly=yes')
  const proxy = config.proxy
  if (proxy?.host) {
    const user = proxy.username ? proxy.username + '@' : ''
    const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? '[' + proxy.host + ']' : proxy.host
    args.push('-J', user + host + ':' + (Number(proxy.port) || 22))
  }
  return args
}

module.exports = { ensurePrivateSshConfig, sshConnectionArgs, sshOptionValue }
