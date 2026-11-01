# request-to-axios

[![npm version](https://img.shields.io/npm/v/request-to-axios)](https://www.npmjs.com/package/request-to-axios)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

A migration aid for legacy Node.js applications that still use [`request`](https://github.com/request/request). It offers a familiar callback and stream API while using [Axios](https://github.com/axios/axios) for HTTP transport.

`request` was deprecated by its maintainers in 2020. This package is an independent compatibility project, not an official successor or an endorsed project of the `request` or Axios maintainers. It does not install or invoke the deprecated `request` package.

## Install

For new code:

```sh
npm install request-to-axios
```

To keep existing `require('request')` statements unchanged, install this package under the old dependency name:

```sh
npm install request@npm:request-to-axios
```

Then migrate incrementally. The alias changes package resolution; it does not make every historical `request` feature identical. Review the [compatibility notes](#compatibility-reference) and [known limitations](#known-limitations) before replacing the old dependency in production.

## Quick Start

```js
const request = require('request');

request.get({
  url: 'https://api.example.test/items',
  qs: { page: 2 },
  json: true
}, (error, response, body) => {
  if (error) {
    console.error(error);
    return;
  }

  console.log(response.statusCode, body);
});
```

The callback shape is `(error, response, body)`. Network, timeout, and parsing failures are reported through `error`. HTTP status codes such as `404` and `500` are not callback errors: inspect `response.statusCode`, as with `request`.

## Examples

### Request Options And Methods

The first argument can be a URL string or an options object. Use `uri` or `url`; `method` defaults to `GET`.

```js
request('https://api.example.test/users/42', (error, response, body) => {
  if (error) return console.error(error);
  console.log(response.statusCode, body);
});

request({
  uri: 'https://api.example.test/users/42',
  method: 'GET',
  headers: { 'x-client': 'legacy-service' },
  timeout: 5000
}, callback);
```

Convenience methods are available for `get`, `post`, `put`, `patch`, `del`/`delete`, `head`, and `options`:

```js
request.post('https://api.example.test/users', {
  json: { name: 'Ada Lovelace' }
}, callback);
```

### JSON

Set `json: true` to send an object in `body` as JSON and parse the response body as JSON. Or set `json` to the value to send directly.

```js
request({
  method: 'POST',
  uri: 'https://api.example.test/events',
  json: { type: 'created', id: 123 },
  headers: { 'x-request-source': 'worker' }
}, (error, response, event) => {
  if (!error) console.log(response.statusCode, event);
});

request({
  uri: 'https://api.example.test/config',
  json: true,
  jsonReviver(key, value) {
    return value;
  }
}, callback);
```

`jsonReplacer` is also supported for request serialization. With `json: true` and no request body, the response is still parsed as JSON.

### Query Strings And Base URLs

`qs` is appended to the URL. Nested values use `qs` serialization by default; `useQuerystring: true` selects Node's built-in `querystring` serializer.

```js
request.get('https://api.example.test/search', {
  qs: { q: 'node streams', tags: ['http', 'client'] },
  qsStringifyOptions: { arrayFormat: 'repeat' }
}, callback);

const api = request.defaults({ baseUrl: 'https://api.example.test/v1/' });
api.get('users/42', callback);
```

`baseUrl` is intended for string endpoints. Leading slashes on the endpoint are stripped before it is joined to the base URL.

### URL-Encoded And Multipart Forms

Use `form` for `application/x-www-form-urlencoded` data:

```js
request.post('https://api.example.test/login', {
  form: { username: 'ada', remember: 'true' }
}, callback);
```

Use `formData` for `multipart/form-data`. Values may be strings, buffers, streams, arrays of values, or `{ value, options }` entries supported by `form-data`.

```js
const fs = require('node:fs');

request.post('https://api.example.test/upload', {
  formData: {
    description: 'report',
    file: {
      value: fs.createReadStream('./report.pdf'),
      options: { filename: 'report.pdf', contentType: 'application/pdf' }
    }
  }
}, callback);
```

The fluent `form()` method returns the `form-data` builder:

```js
const upload = request.post('https://api.example.test/upload', callback);
upload.form().append('label', 'monthly report');
```

### Streaming

The returned object is a duplex stream. Read the response by piping it, iterating it, or listening for `data`; the `response` event exposes the response stream and metadata.

```js
const fs = require('node:fs');

request.get('https://api.example.test/archive.zip')
  .on('response', (response) => {
    console.log(response.statusCode, response.headers['content-type']);
  })
  .pipe(fs.createWriteStream('./archive.zip'));
```

For uploads, pipe a readable stream into a request:

```js
fs.createReadStream('./payload.json')
  .pipe(request.put('https://api.example.test/objects/42', callback));
```

`body` can also be a string, buffer, or readable stream. When using `body` or a stream, set any required content headers explicitly.

### Authentication And Defaults

Immediate Basic authentication and Bearer authentication are supported:

```js
request.get('https://api.example.test/private', {
  auth: { user: process.env.API_USER, pass: process.env.API_PASSWORD }
}, callback);

request.get('https://api.example.test/private', {
  auth: { bearer: () => process.env.API_TOKEN }
}, callback);
```

Avoid hard-coding credentials. Do not send secrets to an untrusted destination or through a proxy you do not control. Deferred authentication (`sendImmediately: false`) and digest challenge retries are not implemented.

`defaults()` returns a separate request function; it does not mutate the exported function:

```js
const api = request.defaults({
  baseUrl: 'https://api.example.test/v1/',
  timeout: 8000,
  headers: { 'x-api-version': '1' }
});

const authenticatedApi = api.defaults({
  headers: { authorization: `Bearer ${process.env.API_TOKEN}` }
});

authenticatedApi.get('users', callback);
```

### Cookies

Cookies are opt-in. Use `jar: true` to use the shared in-memory jar, or create an isolated jar with `request.jar()`:

```js
const jar = request.jar();

request.get({ url: 'https://api.example.test/session', jar }, (error) => {
  if (error) return console.error(error);
  request.get({ url: 'https://api.example.test/profile', jar }, callback);
});
```

The jar can also be populated and inspected directly:

```js
const cookie = request.cookie('theme=dark; Path=/');
jar.setCookie(cookie, 'https://api.example.test/');
console.log(jar.getCookieStringSync('https://api.example.test/'));
```

This built-in jar is deliberately small and does not implement the complete browser cookie standard. It stores host-only cookies in memory, honors path, secure, and expiry attributes, and does not support custom stores or sharing a cookie across subdomains. Do not use it as a browser cookie engine or as persistent session storage.

### TLS, Agents, Proxies, And Timeouts

Axios handles HTTP and HTTPS transport. Node TLS options may be supplied directly or in `agentOptions`; an `agent` can be supplied for custom connection behavior. `forever: true` enables keep-alive when the wrapper creates the agent.

```js
const fs = require('node:fs');

request.get('https://internal.example.test/status', {
  ca: fs.readFileSync('./certs/internal-ca.pem'),
  timeout: 5000,
  proxy: false
}, callback);
```

Axios proxy configuration and its supported proxy environment variables are available. `proxy: false` disables proxying for a request. `localAddress` and `socketPath` are passed to Axios/Node transport options.

TLS certificate verification is enabled by default. **Do not set `strictSSL: false` for production traffic.** It disables certificate verification and allows an active network attacker to impersonate the server. Prefer configuring the correct CA certificate.

`timeout` is passed to Axios as a request timeout; it is not an exact reproduction of `request`'s separate connection and read timeout behavior. `time: true` adds `elapsedTime` to the response, but does not provide the full legacy DNS/TCP timing breakdown.

### Response Encoding, Compression, And Promises

Response bodies are UTF-8 strings by default. Set `encoding: null` to receive a `Buffer`. Set `gzip: true` to request supported compressed responses and have Axios decompress them.

```js
request.get('https://api.example.test/image.png', { encoding: null }, (error, response, image) => {
  if (!error) console.log(Buffer.isBuffer(image));
});
```

The callback API can be promisified with Node's built-in utility:

```js
const { promisify } = require('node:util');

const requestAsync = promisify(request);
const { response, body } = await requestAsync('https://api.example.test/status');
```

## Compatibility Reference

| Area | Behavior in this package |
| --- | --- |
| Invocation | URL/options overloads, callback argument, and `options.callback` |
| Methods | `get`, `post`, `put`, `patch`, `del`, `delete`, `head`, `options` |
| Defaults | `request.defaults(options)` returns an independently configured function |
| URLs | `uri`, `url`, `baseUrl`, and `qs` with `qsStringifyOptions` / `useQuerystring` |
| Request data | `body`, URL-encoded `form`, multipart `formData`, JSON serialization |
| Response data | Callback body text, `Buffer` with `encoding: null`, JSON parsing with `json: true` |
| Streaming | Duplex request stream, response stream event, piping uploads and downloads |
| Authentication | Immediate Basic auth and Bearer tokens (string or function) |
| Redirects | Boolean `followRedirect` and numeric `maxRedirects` through Axios |
| Cookies | `cookie()`, `jar()`, `jar: true`, and an in-memory host-only jar |
| Transport | `timeout`, `proxy`, `agent`, `agentClass`, `agentOptions`, `forever`, `localAddress`, `socketPath`, TLS options, and `strictSSL` |
| Other | `gzip`, `time` as elapsed time, `signal`, `maxBodyLength`, `maxResponseSize`, and `initParams()` |

HTTP error status codes are delivered as normal responses. Check `response.statusCode` yourself. The response object exposes `statusCode`, `statusMessage`, `headers`, `request`, and `caseless.get(name)` in addition to the response stream interface.

## Known Limitations

This project is a compatibility layer, not a byte-for-byte reimplementation. Test your application's actual request patterns before deployment. In particular:

- OAuth 1, Hawk, AWS request signing, HTTP Signature, and HAR 1.2 import are not implemented.
- Digest challenge retry and deferred auth (`sendImmediately: false`) are not implemented.
- `multipart/related`, custom redirect policy callbacks, Unix-socket URL syntax, and the full `request` proxy-tunnel/header behavior are not implemented.
- `followAllRedirects` and `followOriginalHttpMethod` do not reproduce the original library's semantics. The wrapper currently relies on Axios redirect handling.
- The cookie jar is host-only, in-memory, and not a complete browser cookie implementation. Custom stores and public-suffix/domain-cookie rules are not implemented.
- A provided `socketPath` is supported as a transport option, but the special `http://unix:...` URL syntax is not parsed.
- Response metadata and timeout behavior are Axios/Node-based and may differ from `request` in edge cases.

Please open a [compatibility issue](https://github.com/prithwirajbose/request-to-axios/issues) with a minimal reproduction if an application relies on a behavior not listed here.

## Security

### Security Position

The original [`request` project](https://github.com/request/request) is deprecated and its maintainers state that no new changes are expected. Deprecation means upstream maintenance has stopped; it does **not**, by itself, prove that every installation is vulnerable. Review the versions actually used by your application with `npm audit` and your organization's security tooling.

This package is intended to make migration away from an unmaintained HTTP client easier. It cannot guarantee that the package, Axios, Node.js, or any dependency will always be free of vulnerabilities. Security status changes over time, so a clean audit at one point is not a permanent guarantee.

### Security Practices

- The HTTP implementation uses Axios. URL-encoded serialization uses `qs`; multipart uploads use `form-data`. Cookie storage is implemented in this package without a cookie-jar dependency.
- The package does not install or execute the deprecated `request` library.
- Check the dependency graph before deployment and after updates: `npm audit` and `npm ls --all`.
- Keep Node.js on a supported release line and update this package and its dependencies regularly.
- Use HTTPS for sensitive data, keep TLS certificate verification enabled, and configure private CAs rather than disabling verification.
- Treat redirects and proxies as trust boundaries. Avoid forwarding credentials, cookies, or sensitive bodies to destinations that have not been verified.
- Do not put credentials in source control, URLs, logs, or issue reports. Use environment-based secret injection or a secret manager.
- The cookie jar is process-local and in-memory. It is not encrypted persistent storage and has no browser SameSite enforcement.

### Maintainer Security Commitment

As maintainer, I commit to monitoring direct and transitive dependencies at least monthly and before each release, reviewing credible security reports, and publishing security updates when fixes are available and validated. My target is to publish a critical-severity fix within 72 hours and a high-severity fix within 7 calendar days after a viable upstream fix is available. If a dependency has no fix, I will document the exposure and mitigation or replace the dependency where practical.

These are response targets, not a guarantee that every vulnerability can be fixed within those windows. A release may depend on upstream maintainers, compatibility testing, or a safe migration path. I will communicate material delays and workarounds through the [GitHub security advisories](https://github.com/prithwirajbose/request-to-axios/security/advisories) and [project issues](https://github.com/prithwirajbose/request-to-axios/issues).

### Report A Vulnerability

Please do not publish an unpatched vulnerability as a public issue. Report it privately through [GitHub's security advisory feature](https://github.com/prithwirajbose/request-to-axios/security/advisories/new). Include the affected version, impact, and a minimal reproduction; do not include real credentials, tokens, or customer data. If private reporting is unavailable, contact the maintainer at [sribasu.com](https://sribasu.com) and request a private security channel.

## Credits And Links

- Compatibility target and historical API reference: [request/request](https://github.com/request/request). The original project and its contributors retain their respective credit; this package is independent and unaffiliated.
- HTTP transport: [Axios](https://github.com/axios/axios) and [Axios documentation](https://axios-http.com/docs/intro).
- Multipart encoding: [form-data](https://github.com/form-data/form-data).
- Query serialization: [qs](https://github.com/ljharb/qs).
- Maintainer: [Prithwiraj Bose](https://sribasu.com).
- Source, issues, and releases: [request-to-axios on GitHub](https://github.com/prithwirajbose/request-to-axios).
- Package: [request-to-axios on npm](https://www.npmjs.com/package/request-to-axios).

## Development

The library runtime supports Node.js 16.9 or later. The included `node:test` suite uses Node.js 18 or later; Node 16.9 can load and use the library but cannot run the test command as written.

```sh
npm install
npm test
npm audit
```

## License

[MIT](https://opensource.org/license/mit/), as declared in `package.json`.