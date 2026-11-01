'use strict';

const { Duplex, PassThrough } = require('node:stream');
const http = require('node:http');
const https = require('node:https');
const querystring = require('node:querystring');
const axios = require('axios');
const FormData = require('form-data');
const qs = require('qs');

const defaultOptions = {
    method: 'GET',
    headers: {},
    followRedirect: true,
    followAllRedirects: false,
    maxRedirects: 10,
    encoding: 'utf8',
    gzip: false
};

function mergeOptions(base, override) {
    const result = { ...base, ...override };
    result.headers = { ...(base.headers || {}), ...(override.headers || {}) };
    for (const key of ['auth', 'agentOptions', 'qsStringifyOptions']) {
        if (base[key] && override[key] && typeof base[key] === 'object' && typeof override[key] === 'object') {
            result[key] = { ...base[key], ...override[key] };
        }
    }
    return result;
}

function normalizeArgs(uri, options, callback) {
    if (typeof uri === 'function') return { options: {}, callback: uri };
    if (typeof options === 'function') return { options: typeof uri === 'string' ? { uri } : { ...(uri || {}) }, callback: options };
    if (typeof uri === 'string' || (uri && typeof uri.href === 'string')) {
        return { options: { ...(options || {}), uri }, callback };
    }
    return { options: { ...(uri || {}), ...(options || {}) }, callback };
}

function getUrl(options) {
    let uri = options.uri || options.url;
    if (uri && typeof uri === 'object' && typeof uri.href === 'string') uri = uri.href;
    if (typeof uri !== 'string' || uri.length === 0) throw new TypeError('A uri or url option is required');
    if (options.baseUrl) {
        if (typeof options.uri !== 'string' && typeof options.url !== 'string') throw new TypeError('uri must be a string when baseUrl is set');
        const base = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
        uri = new URL(uri.replace(/^\//, ''), base).href;
    }
    const url = new URL(uri);
    if (options.qs && typeof options.qs === 'object') {
        const stringifyOptions = options.qsStringifyOptions || {};
        const serialized = options.useQuerystring ?
            querystring.stringify(options.qs, stringifyOptions.sep || '&', stringifyOptions.eq || '=', stringifyOptions.options || {}) :
            qs.stringify(options.qs, stringifyOptions);
        for (const [key, value] of new URLSearchParams(serialized)) url.searchParams.append(key, value);
    }
    return url.href;
}

function setHeader(headers, name, value) {
    const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    headers[existing || name] = value;
}

function getHeader(headers, name) {
    const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : undefined;
}

function parseCookie(input) {
    if (input instanceof RequestCookie) return input;
    const [pair, ...attributes] = String(input).split(';');
    const separator = pair.indexOf('=');
    if (separator <= 0) return null;
    const cookie = new RequestCookie(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    for (const attribute of attributes) {
        const [rawName, ...rawValue] = attribute.trim().split('=');
        const name = rawName.toLowerCase();
        const value = rawValue.join('=').trim();
        if (name === 'domain') cookie.domain = value.replace(/^\./, '').toLowerCase();
        else if (name === 'path' && value.startsWith('/')) cookie.path = value;
        else if (name === 'expires') {
            const expires = Date.parse(value);
            if (Number.isFinite(expires)) cookie.expires = expires;
        } else if (name === 'max-age' && /^-?\d+$/.test(value)) cookie.maxAge = Number(value);
        else if (name === 'secure') cookie.secure = true;
        else if (name === 'httponly') cookie.httpOnly = true;
        else if (name === 'samesite') cookie.sameSite = value.toLowerCase();
    }
    return cookie;
}

class RequestCookie {
    constructor(key, value) {
        this.key = key;
        this.value = value;
        this.path = '/';
        this.secure = false;
        this.httpOnly = false;
        this.hostOnly = true;
    }

    static parse(value) {
        return parseCookie(value);
    }

    toString() {
        return `${this.key}=${this.value}`;
    }
}

class RequestCookieJar {
    constructor() {
        this.cookies = new Map();
    }

    setCookieSync(input, uri) {
        const cookie = parseCookie(input);
        if (!cookie) return null;
        const url = new URL(uri);
        const hostname = url.hostname.toLowerCase();
        if (cookie.domain && cookie.domain !== hostname) return null;
        cookie.domain = hostname;
        cookie.hostOnly = true;
        if (cookie.path === '/') {
            const lastSlash = url.pathname.lastIndexOf('/');
            cookie.path = lastSlash > 0 ? url.pathname.slice(0, lastSlash) : '/';
        }
        if (cookie.maxAge !== undefined) cookie.expires = Date.now() + cookie.maxAge * 1000;
        const key = `${cookie.domain}\n${cookie.path}\n${cookie.key}`;
        if (cookie.maxAge <= 0 || cookie.expires <= Date.now()) this.cookies.delete(key);
        else this.cookies.set(key, cookie);
        return cookie;
    }

    getCookiesSync(uri) {
        const url = new URL(uri);
        const now = Date.now();
        const found = [];
        for (const [key, cookie] of this.cookies) {
            if (cookie.expires !== undefined && cookie.expires <= now) {
                this.cookies.delete(key);
                continue;
            }
            const pathMatches = url.pathname === cookie.path ||
                (url.pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/'));
            if (cookie.domain === url.hostname.toLowerCase() && pathMatches && (!cookie.secure || url.protocol === 'https:')) found.push(cookie);
        }
        return found.sort((left, right) => right.path.length - left.path.length);
    }

    getCookieStringSync(uri) {
        return this.getCookiesSync(uri).map(String).join('; ');
    }

    setCookie(input, uri, options, callback) {
        if (typeof options === 'function') callback = options;
        const cookie = this.setCookieSync(input, uri);
        if (callback) queueMicrotask(() => callback(null, cookie));
        return cookie;
    }

    getCookies(uri, callback) {
        const cookies = this.getCookiesSync(uri);
        if (callback) queueMicrotask(() => callback(null, cookies));
        return cookies;
    }

    getCookieString(uri, callback) {
        const value = this.getCookieStringSync(uri);
        if (callback) queueMicrotask(() => callback(null, value));
        return value;
    }
}

const sharedJar = new RequestCookieJar();

function serializeForm(value, options) {
    if (typeof value === 'string') return value;
    const stringifyOptions = options.qsStringifyOptions || {};
    return options.useQuerystring ?
        querystring.stringify(value, stringifyOptions.sep || '&', stringifyOptions.eq || '=', stringifyOptions.options || {}) :
        qs.stringify(value, stringifyOptions);
}

function prepareOptions(input) {
    const options = { ...input, headers: { ...(input.headers || {}) } };
    options.method = String(options.method || 'GET').toUpperCase();
    options.url = getUrl(options);

    let data = options.body;
    if (options.form !== undefined && options.form !== null) {
        data = serializeForm(options.form, options);
        setHeader(options.headers, 'content-type', 'application/x-www-form-urlencoded');
    }
    if (options.formData !== undefined) {
        const form = options._formInstance || new FormData();
        if (!options._formInstance) {
            for (const [key, rawValue] of Object.entries(options.formData)) {
                const entries = Array.isArray(rawValue) ? rawValue : [rawValue];
                for (const entry of entries) {
                    if (entry && typeof entry === 'object' && Object.hasOwn(entry, 'value')) {
                        form.append(key, entry.value, entry.options || {});
                    } else {
                        form.append(key, entry);
                    }
                }
            }
        }
        data = form;
        Object.assign(options.headers, form.getHeaders());
    }
    if (options.json) {
        setHeader(options.headers, 'accept', 'application/json');
        if (options.json !== true) data = options.json;
        if (data !== undefined && data !== null && !Buffer.isBuffer(data) && typeof data !== 'string' && typeof data.pipe !== 'function') {
            data = JSON.stringify(data, options.jsonReplacer);
        }
        if (data !== undefined && data !== null) setHeader(options.headers, 'content-type', 'application/json');
    }
    if (options.gzip) {
        if (!getHeader(options.headers, 'accept-encoding')) setHeader(options.headers, 'accept-encoding', 'gzip, deflate, br');
    } else if (!getHeader(options.headers, 'accept-encoding')) {
        setHeader(options.headers, 'accept-encoding', 'identity');
    }

    const auth = options.auth;
    if (auth) {
        if (auth.bearer !== undefined) {
            const token = typeof auth.bearer === 'function' ? auth.bearer() : auth.bearer;
            setHeader(options.headers, 'authorization', `Bearer ${token}`);
        } else if ((auth.user !== undefined || auth.username !== undefined) && auth.sendImmediately !== false) {
            const user = auth.user === undefined ? auth.username : auth.user;
            const pass = auth.pass === undefined ? auth.password || '' : auth.pass;
            setHeader(options.headers, 'authorization', `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`);
        }
    }

    const jar = options.jar === true ? sharedJar : options.jar;
    if (jar && typeof jar.getCookieStringSync === 'function') {
        const cookie = jar.getCookieStringSync(options.url);
        if (cookie) setHeader(options.headers, 'cookie', cookie);
    }

    const protocol = new URL(options.url).protocol;
    const transportOptions = options.agentOptions || {};
    const tlsOptions = { ...transportOptions };
    for (const key of ['cert', 'key', 'pfx', 'ca', 'passphrase', 'ciphers', 'secureProtocol', 'servername', 'rejectUnauthorized']) {
        if (options[key] !== undefined) tlsOptions[key] = options[key];
    }
    if (options.strictSSL === false) tlsOptions.rejectUnauthorized = false;
    let agent = options.agent;
    if (!agent && (options.forever || Object.keys(tlsOptions).length > 0)) {
        const Agent = options.agentClass ? require(options.agentClass) : (protocol === 'https:' ? https.Agent : http.Agent);
        agent = new Agent({ keepAlive: Boolean(options.forever), ...tlsOptions });
    }

    return { options, data, jar, agent };
}

class RequestStream extends Duplex {
    constructor(options, callback) {
        super({ autoDestroy: false });
        this.options = options;
        this.callback = callback;
        this.upload = new PassThrough();
        this.uploaded = false;
        this.finishedResponse = false;
        this.startedAt = Date.now();
        this._responseChunks = [];
        this._startScheduled = true;
        setImmediate(() => this._dispatch());
    }

    _read() { }

    _write(chunk, encoding, callback) {
        this.uploaded = true;
        this.upload.write(chunk, encoding, callback);
    }

    _final(callback) {
        this.upload.end(callback);
    }

    _destroy(error, callback) {
        if (this.cancelSource) this.cancelSource();
        this.upload.destroy(error || undefined);
        callback(error);
    }

    _dispatch() {
        if (this.destroyed) return;
        let prepared;
        try {
            prepared = prepareOptions(this.options);
        } catch (error) {
            this._finish(error);
            return;
        }
        const { options, jar, agent } = prepared;
        const hasBodyOption = prepared.data !== undefined && prepared.data !== null;
        let data = prepared.data;
        if (!hasBodyOption && !['GET', 'HEAD'].includes(options.method)) {
            data = this.upload;
            if (!this.uploaded && !this.writableEnded) this.upload.end();
        }

        const config = {
            url: options.url,
            method: options.method,
            headers: options.headers,
            data,
            paramsSerializer: options.qsStringifyOptions,
            timeout: options.timeout || 0,
            maxRedirects: options.followRedirect === false ? 0 : (options.maxRedirects === undefined ? 10 : options.maxRedirects),
            validateStatus: () => true,
            responseType: 'stream',
            decompress: Boolean(options.gzip),
            proxy: options.proxy === false || options.proxy === null ? false : options.proxy,
            httpAgent: agent || options.agent,
            httpsAgent: agent || options.agent,
            maxContentLength: options.maxResponseSize || Infinity,
            maxBodyLength: options.maxBodyLength || Infinity,
            socketPath: options.socketPath,
            localAddress: options.localAddress,
            signal: options.signal
        };
        if (options.encoding === null) config.responseEncoding = 'binary';
        if (options.responseType) config.responseType = options.responseType;
        if (options.time) config.onUploadProgress = undefined;
        this._timing = { timingStart: this.startedAt, timings: {} };

        axios(config).then((result) => {
            const response = result.data;
            response.statusCode = result.status;
            response.statusMessage = result.statusText;
            response.headers = result.headers;
            response.request = result.request;
            response.caseless = { get: (name) => getHeader(response.headers, name) };
            if (options.time) response.elapsedTime = Date.now() - this.startedAt;
            this.response = response;
            this.emit('response', response);

            if (jar && typeof jar.setCookieSync === 'function') {
                const cookies = response.headers['set-cookie'] || [];
                for (const cookie of cookies) {
                    try { jar.setCookieSync(cookie, options.url); } catch { }
                }
            }
            response.on('data', (chunk) => {
                this._responseChunks.push(Buffer.from(chunk));
                this.push(chunk);
            });
            response.on('error', (error) => this._finish(error, response));
            response.on('end', () => {
                this.finishedResponse = true;
                this.push(null);
                const bodyBuffer = Buffer.concat(this._responseChunks);
                let body = options.encoding === null ? bodyBuffer : bodyBuffer.toString(options.encoding || 'utf8');
                if (options.json) {
                    try { body = JSON.parse(body, options.jsonReviver); }
                    catch (error) { this._finish(error, response); return; }
                }
                this._finish(null, response, body);
            });
        }).catch((error) => {
            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') error.code = 'ETIMEDOUT';
            this._finish(error);
        });
    }

    _finish(error, response, body) {
        if (this._callbackCalled) return;
        this._callbackCalled = true;
        if (error && !this.destroyed) this.emit('error', error);
        if (typeof this.callback === 'function') this.callback(error || null, response || null, body);
    }

    abort() {
        if (this.response && typeof this.response.destroy === 'function') this.response.destroy();
        this.destroy(Object.assign(new Error('Request aborted'), { code: 'ECONNRESET' }));
        return this;
    }

    auth(user, pass, sendImmediately, bearer) {
        this.options.auth = bearer !== undefined
            ? { bearer }
            : { user, pass, sendImmediately };
        return this;
    }

    form(value) {
        if (value !== undefined) {
            this.options.form = value;
            return this;
        }
        const form = new FormData();
        this.options.formData = Object.create(null);
        this.options._formInstance = form;
        return form;
    }

    json(value) {
        this.options.json = value === undefined ? true : value;
        return this;
    }
}

function createRequest(defaults = {}) {
    function request(uri, options, callback) {
        const args = normalizeArgs(uri, options, callback);
        const merged = mergeOptions(mergeOptions(defaultOptions, defaults), args.options);
        const cb = args.callback || merged.callback;
        delete merged.callback;
        return new RequestStream(merged, cb);
    }

    for (const [method, name] of Object.entries({ get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE', delete: 'DELETE', head: 'HEAD', options: 'OPTIONS' })) {
        request[method] = (uri, options, callback) => {
            const args = normalizeArgs(uri, options, callback);
            args.options.method = args.options.method || name;
            return request(args.options, args.callback);
        };
    }
    request.defaults = (options) => createRequest(mergeOptions(defaults, options || {}));
    request.cookie = (string) => RequestCookie.parse(string);
    request.jar = (store) => {
        if (store) throw new TypeError('Custom cookie stores are not supported');
        return new RequestCookieJar();
    };
    request.debug = false;
    request.Request = RequestStream;
    request.initParams = (options) => prepareOptions(options || {});
    request._axios = axios;
    return request;
}

module.exports = createRequest();