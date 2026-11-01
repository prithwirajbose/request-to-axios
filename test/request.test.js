'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const test = require('node:test');
const request = require('../');

let server;
let baseUrl;

test.before(async() => {
    server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            if (req.url.startsWith('/redirect')) {
                res.writeHead(302, { location: '/json' }).end();
            } else if (req.url.startsWith('/cookie')) {
                res.setHeader('set-cookie', 'session=abc123; Path=/; HttpOnly');
                res.end('cookie set');
            } else if (req.url.startsWith('/json')) {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ method: req.method, query: req.url, body, header: req.headers['x-test'] || null, cookie: req.headers.cookie || null }));
            } else {
                res.statusCode = 418;
                res.end('teapot');
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async() => new Promise((resolve) => server.close(resolve)));

function send(options) {
    return new Promise((resolve, reject) => {
        request(options, (error, response, body) => error ? reject(error) : resolve({ response, body }));
    });
}

test('supports request-style options, qs, JSON parsing, and callback metadata', async() => {
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
        cookie: null
    });
});

test('does not reject HTTP error status codes like request', async() => {
    const { response, body } = await send(`${baseUrl}/error`);
    assert.equal(response.statusCode, 418);
    assert.equal(body, 'teapot');
});

test('supports method aliases and redirects', async() => {
    const { response, body } = await new Promise((resolve, reject) => {
        request.get(`${baseUrl}/redirect`, (error, response, body) => error ? reject(error) : resolve({ response, body }));
    });
    assert.equal(response.statusCode, 200);
    assert.match(body, /"method":"GET"/);
});

test('emits the response stream and streams its body to consumers', async() => {
    const chunks = [];
    const stream = request.get(`${baseUrl}/json`);
    stream.on('response', (response) => assert.equal(response.statusCode, 200));
    for await (const chunk of stream) chunks.push(chunk);
    assert.match(Buffer.concat(chunks).toString(), /"method":"GET"/);
});

test('emits each response data chunk only once', async() => {
    const chunks = [];
    await new Promise((resolve, reject) => {
        request.get(`${baseUrl}/json`, (error) => error ? reject(error) : resolve())
            .on('data', (chunk) => chunks.push(chunk));
    });
    assert.equal(Buffer.concat(chunks).toString().match(/"method":"GET"/g).length, 1);
});

test('encodes urlencoded forms and multipart formData', async() => {
    const formResponse = await send({ uri: `${baseUrl}/json`, method: 'POST', form: { name: 'Ada Lovelace' } });
    assert.equal(JSON.parse(formResponse.body).body, 'name=Ada%20Lovelace');

    const multipartResponse = await send({ uri: `${baseUrl}/json`, method: 'POST', formData: { name: 'Ada' } });
    assert.match(JSON.parse(multipartResponse.body).body, /name="name"\r\n\r\nAda/);
});

test('supports the fluent form builder and piping a request body', async() => {
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

test('stores response cookies in an explicit in-memory jar', async() => {
    const jar = request.jar();
    await send({ uri: `${baseUrl}/cookie`, jar });
    assert.equal(jar.getCookieStringSync(`${baseUrl}/json`), 'session=abc123');
    const { body } = await send({ uri: `${baseUrl}/json`, jar });
    assert.equal(JSON.parse(body).cookie, 'session=abc123');
    assert.equal(jar.getCookieStringSync('http://localhost/json'), '');
});