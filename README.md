# request-to-axios

Request-style Node.js HTTP calls backed by Axios. This package is intended as a migration aid for code that imports `request`; it does not install or invoke the deprecated `request` package.

To keep existing `require('request')` imports unchanged, install this package under the legacy dependency name:

```sh
npm install request@npm:request-to-axios
```

```js
const request = require('request');

request.get({
  url: 'https://api.example.test/items',
  qs: { page: 2 },
  json: true
}, (error, response, body) => {
  if (error) throw error;
  console.log(response.statusCode, body);
});
```

## Compatibility surface

Implemented: `request(uri, options, callback)` argument forms; callback in options; `get`, `post`, `put`, `patch`, `del`/`delete`, `head`, and `options`; `defaults()`; callback errors and response/body shape; response piping and `response` events; `uri`/`url`/`baseUrl`; methods, headers, `qs` and querystring serialization; `body`, `form`, `formData`, JSON request/response encoding and reviver/replacer; basic and bearer auth; timeouts; redirects; in-memory cookies and jars; proxy settings; agents, keep-alive and TLS settings; local address/socket path; abort; response encoding; gzip opt-in; `time`; `cookie()`, `jar()`, and `initParams()`.

The cookie jar has no third-party dependency. It supports host-only cookies, paths, secure cookies, expiry, and in-memory persistence; custom stores and domain cookies spanning subdomains are not supported.

HTTP error status codes are delivered through `response.statusCode`, not as callback errors, matching `request`. The callback body is a string by default, a `Buffer` with `encoding: null`, and a parsed value with `json: true`.

## Migration boundaries

This is not a byte-for-byte replacement for the deprecated package. OAuth 1 signing, Hawk, AWS request signing, HTTP Signature, HAR 1.2 option import, Unix socket URL parsing, custom redirect policy callbacks, digest challenge retry, and exact multipart/related framing are not implemented yet. `followAllRedirects` and `followOriginalHttpMethod` are accepted options but currently follow Axios redirect behavior; review these options before migrating code that depends on their exact semantics. Axios response streams are used for the `response` event, and all response bytes are also exposed through the returned duplex stream.

Run the local compatibility checks with `npm test`.