'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { once } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const test = require('node:test');
const { promisify } = require('node:util');
const zlib = require('node:zlib');
const request = require('../');

let server;
let baseUrl;

test.before(async () => {
    server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            if (req.url.startsWith('/redirect')) {
                res.writeHead(302, { location: '/json' }).end();
            } else if (req.url.startsWith('/cookie') || req.url.startsWith('/session')) {
                res.setHeader('set-cookie', 'session=abc123; Path=/; HttpOnly');
                res.end('cookie set');
            } else if (req.url.startsWith('/archive.zip')) {
                res.setHeader('content-type', 'application/zip');
                res.end(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]));
            } else if (req.url.startsWith('/compressed')) {
                res.setHeader('content-type', 'text/plain');
                res.setHeader('content-encoding', 'gzip');
                res.end(zlib.gzipSync('compressed response'));
            } else if (req.url.startsWith('/config')) {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ state: 'ready', count: '42' }));
            } else if (req.url.startsWith('/error')) {
                res.statusCode = 418;
                res.end('teapot');
            } else {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({
                    method: req.method,
                    query: req.url,
                    body,
                    header: req.headers['x-test'] || null,
                    cookie: req.headers.cookie || null,
                    authorization: req.headers.authorization || null,
                    client: req.headers['x-client'] || null,
                    apiVersion: req.headers['x-api-version'] || null,
                    requestSource: req.headers['x-request-source'] || null
                }));
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => new Promise((resolve) => server.close(resolve)));

function send(options) {
    return new Promise((resolve, reject) => {
        request(options, (error, response, body) => error ? reject(error) : resolve({ response, body }));
    });
}

function sendWith(invoke) {
    return new Promise((resolve, reject) => {
        invoke((error, response, body) => error ? reject(error) : resolve({ response, body }));
    });
}

test('supports request-style options, qs, JSON parsing, and callback metadata', async () => {
    const { response, body } = await send({
        uri: `${baseUrl}/json?existing=1`,
        method: 'POST',
        qs: { tag: ['one', 'two'] },
        json: { hello: 'world' },
        headers: { 'x-test': 'works' }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.caseless.get('Content-Type'), 'application/json');
    assert.deepEqual(body, {
        method: 'POST',
        query: '/json?existing=1&tag%5B0%5D=one&tag%5B1%5D=two',
        body: '{"hello":"world"}',
        header: 'works',
        cookie: null,
        authorization: null,
        client: null,
        apiVersion: null,
        requestSource: null
    });
});

test('does not reject HTTP error status codes like request', async () => {
    const { response, body } = await send(`${baseUrl}/error`);
    assert.equal(response.statusCode, 418);
    assert.equal(body, 'teapot');
});

test('supports method aliases and redirects', async () => {
    const { response, body } = await new Promise((resolve, reject) => {
        request.get(`${baseUrl}/redirect`, (error, response, body) => error ? reject(error) : resolve({ response, body }));
    });
    assert.equal(response.statusCode, 200);
    assert.match(body, /"method":"GET"/);
});

test('emits the response stream and streams its body to consumers', async () => {
    const chunks = [];
    const stream = request.get(`${baseUrl}/json`);
    stream.on('response', (response) => assert.equal(response.statusCode, 200));
    for await (const chunk of stream) chunks.push(chunk);
    assert.match(Buffer.concat(chunks).toString(), /"method":"GET"/);
});

test('emits each response data chunk only once', async () => {
    const chunks = [];
    await new Promise((resolve, reject) => {
        request.get(`${baseUrl}/json`, (error) => error ? reject(error) : resolve())
            .on('data', (chunk) => chunks.push(chunk));
    });
    assert.equal(Buffer.concat(chunks).toString().match(/"method":"GET"/g).length, 1);
});

test('encodes urlencoded forms and multipart formData', async () => {
    const formResponse = await send({ uri: `${baseUrl}/json`, method: 'POST', form: { name: 'Ada Lovelace' } });
    assert.equal(JSON.parse(formResponse.body).body, 'name=Ada%20Lovelace');

    const multipartResponse = await send({ uri: `${baseUrl}/json`, method: 'POST', formData: { name: 'Ada' } });
    assert.match(JSON.parse(multipartResponse.body).body, /name="name"\r\n\r\nAda/);
});

test('supports the fluent form builder and piping a request body', async () => {
    const fluentResponse = await new Promise((resolve, reject) => {
        const stream = request.post(`${baseUrl}/json`, (error, response, body) => error ? reject(error) : resolve(body));
        stream.form().append('name', 'Grace');
    });
    assert.match(JSON.parse(fluentResponse).body, /name="name"\r\n\r\nGrace/);

    const uploaded = await new Promise((resolve, reject) => {
        const destination = request.put(`${baseUrl}/json`, (error, response, body) => error ? reject(error) : resolve(body));
        Readable.from(['streamed payload']).pipe(destination);
    });
    assert.equal(JSON.parse(uploaded).body, 'streamed payload');
});

test('covers the quick-start and URL/options callback examples', async () => {
    const quickStart = await sendWith((callback) => request.get({
        url: `${baseUrl}/items`,
        qs: { page: 2 },
        json: true
    }, callback));
    assert.equal(quickStart.response.statusCode, 200);
    assert.equal(quickStart.body.query, '/items?page=2');

    const urlCall = await sendWith((callback) => request(`${baseUrl}/users/42`, callback));
    assert.equal(urlCall.response.statusCode, 200);

    const optionsCall = await sendWith((callback) => request({
        uri: `${baseUrl}/users/42`,
        method: 'GET',
        headers: { 'x-client': 'legacy-service' },
        timeout: 5000
    }, callback));
    assert.equal(JSON.parse(optionsCall.body).client, 'legacy-service');
});

test('covers each documented HTTP method helper', async () => {
    const methods = [
        ['get', 'GET'],
        ['post', 'POST'],
        ['put', 'PUT'],
        ['patch', 'PATCH'],
        ['del', 'DELETE'],
        ['delete', 'DELETE'],
        ['head', 'HEAD'],
        ['options', 'OPTIONS']
    ];
    for (const [helper, expectedMethod] of methods) {
        const { response, body } = await sendWith((callback) => request[helper](`${baseUrl}/methods`, callback));
        assert.equal(response.statusCode, 200);
        if (expectedMethod !== 'HEAD') assert.equal(JSON.parse(body).method, expectedMethod);
        else assert.equal(body, '');
    }

    const post = await sendWith((callback) => request.post(`${baseUrl}/users`, {
        json: { name: 'Ada Lovelace' }
    }, callback));
    assert.equal(post.body.body, '{"name":"Ada Lovelace"}');
});

test('covers JSON reviver and replacer examples', async () => {
    const event = await sendWith((callback) => request({
        method: 'POST',
        uri: `${baseUrl}/events`,
        json: { type: 'created', id: 123 },
        headers: { 'x-request-source': 'worker' }
    }, callback));
    assert.equal(event.body.requestSource, 'worker');

    const config = await sendWith((callback) => request({
        uri: `${baseUrl}/config`,
        json: true,
        jsonReviver(key, value) {
            return key === 'state' ? value.toUpperCase() : value;
        }
    }, callback));
    assert.deepEqual(config.body, { state: 'READY', count: '42' });

    const replaced = await sendWith((callback) => request({
        method: 'POST',
        uri: `${baseUrl}/json`,
        json: { visible: 'yes', hidden: 'no' },
        jsonReplacer(key, value) {
            return key === 'hidden' ? undefined : value;
        }
    }, callback));
    assert.equal(replaced.body.body, '{"visible":"yes"}');
});

test('covers qs serialization and baseUrl defaults', async () => {
    const search = await sendWith((callback) => request.get(`${baseUrl}/search`, {
        qs: { q: 'node streams', tags: ['http', 'client'] },
        qsStringifyOptions: { arrayFormat: 'repeat' }
    }, callback));
    assert.equal(JSON.parse(search.body).query, '/search?q=node+streams&tags=http&tags=client');

    const api = request.defaults({ baseUrl: `${baseUrl}/v1/` });
    const user = await sendWith((callback) => api.get('users/42', callback));
    assert.equal(JSON.parse(user.body).query, '/v1/users/42');
});

test('covers multipart file upload and fluent form examples', async () => {
    const upload = await sendWith((callback) => request.post(`${baseUrl}/upload`, {
        formData: {
            description: 'report',
            file: {
                value: fs.createReadStream(__filename),
                options: { filename: 'report.pdf', contentType: 'application/pdf' }
            }
        }
    }, callback));
    const uploadedBody = JSON.parse(upload.body).body;
    assert.match(uploadedBody, /name="description"\r\n\r\nreport/);
    assert.match(uploadedBody, /filename="report\.pdf"/);
    assert.match(uploadedBody, /Content-Type: application\/pdf/);

    const fluent = await sendWith((callback) => {
        const stream = request.post(`${baseUrl}/upload`, callback);
        stream.form().append('label', 'monthly report');
    });
    assert.match(JSON.parse(fluent.body).body, /name="label"\r\n\r\nmonthly report/);
});

test('covers response piping, binary encoding, and gzip examples', async () => {
    const download = request.get(`${baseUrl}/archive.zip`);
    let responseSeen = false;
    download.on('response', (response) => {
        responseSeen = true;
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'application/zip');
    });
    const destination = new PassThrough();
    const chunks = [];
    destination.on('data', (chunk) => chunks.push(chunk));
    const completed = once(destination, 'finish');
    download.pipe(destination);
    await completed;
    assert.equal(responseSeen, true);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]));

    const binary = await send({ uri: `${baseUrl}/archive.zip`, encoding: null });
    assert.ok(Buffer.isBuffer(binary.body));

    const compressed = await send({ uri: `${baseUrl}/compressed`, gzip: true });
    assert.equal(compressed.body, 'compressed response');
});

test('covers immediate Basic and Bearer authentication examples', async () => {
    const basic = await send({
        uri: `${baseUrl}/private`,
        auth: { user: 'test-user', pass: 'test-password' }
    });
    assert.equal(JSON.parse(basic.body).authorization, `Basic ${Buffer.from('test-user:test-password').toString('base64')}`);

    const bearer = await send({
        uri: `${baseUrl}/private`,
        auth: { bearer: () => 'test-token' }
    });
    assert.equal(JSON.parse(bearer.body).authorization, 'Bearer test-token');
});

test('covers chained defaults and request headers', async () => {
    const api = request.defaults({
        baseUrl: `${baseUrl}/v1/`,
        timeout: 8000,
        headers: { 'x-api-version': '1' }
    });
    const authenticatedApi = api.defaults({
        headers: { authorization: 'Bearer test-token' }
    });
    const { body } = await sendWith((callback) => authenticatedApi.get('users', callback));
    const result = JSON.parse(body);
    assert.equal(result.query, '/v1/users');
    assert.equal(result.apiVersion, '1');
    assert.equal(result.authorization, 'Bearer test-token');
});

test('covers cookie example population and inspection APIs', async () => {
    const jar = request.jar();
    await send({ uri: `${baseUrl}/session`, jar });
    await send({ uri: `${baseUrl}/profile`, jar });
    assert.equal(jar.getCookieStringSync(`${baseUrl}/profile`), 'session=abc123');

    const explicitJar = request.jar();
    const cookie = request.cookie('theme=dark; Path=/');
    explicitJar.setCookie(cookie, baseUrl);
    assert.equal(explicitJar.getCookieStringSync(baseUrl), 'theme=dark');
});

test('covers TLS option normalization and proxy bypass example', () => {
    const ca = fs.readFileSync(__filename);
    const prepared = request.initParams({
        uri: 'https://internal.example.test/status',
        ca,
        timeout: 5000,
        proxy: false
    });
    assert.equal(prepared.options.timeout, 5000);
    assert.equal(prepared.options.proxy, false);
    assert.deepEqual(prepared.agent.options.ca, ca);
});

test('covers callback promisification with the full legacy result', async () => {
    const requestAsync = promisify((options, callback) => {
        request(options, (error, response, body) => callback(error, { response, body }));
    });
    const { response, body } = await requestAsync({ uri: `${baseUrl}/status` });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(body).method, 'GET');
});

test('stores response cookies in an explicit in-memory jar', async () => {
    const jar = request.jar();
    await send({ uri: `${baseUrl}/cookie`, jar });
    assert.equal(jar.getCookieStringSync(`${baseUrl}/json`), 'session=abc123');
    const { body } = await send({ uri: `${baseUrl}/json`, jar });
    assert.equal(JSON.parse(body).cookie, 'session=abc123');
    assert.equal(jar.getCookieStringSync('http://localhost/json'), '');
});