"""Cloudflare R2 icin kucuk S3 istemcisi. Yalnizca standart kutuphane: Vercel paketi hafif kalsin."""
import datetime
import hashlib
import hmac
import shutil
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UNSIGNED = "UNSIGNED-PAYLOAD"
_quote = lambda value, safe="-_.~": urllib.parse.quote(str(value), safe=safe)


def _sign(key, text):
    return hmac.new(key, text.encode(), hashlib.sha256).digest()


class R2:
    def __init__(self, endpoint, bucket, access_key, secret_key, region="auto", now=None):
        self.endpoint, self.bucket = endpoint.rstrip("/"), bucket
        self.access_key, self.secret_key, self.region = access_key, secret_key, region
        self.host = urllib.parse.urlsplit(self.endpoint).netloc
        self._now = now or (lambda: datetime.datetime.now(datetime.timezone.utc))

    def _path(self, key):
        return "/" + _quote(self.bucket) + ("/" + _quote(key, "/-_.~") if key else "")

    def _signature(self, method, path, query, headers, payload, stamp):
        date = stamp[:8]
        scope = f"{date}/{self.region}/s3/aws4_request"
        names = sorted(headers)
        canonical = "\n".join([method, path, "&".join(f"{_quote(k)}={_quote(v)}" for k, v in sorted(query.items())),
                               "".join(f"{k}:{headers[k]}\n" for k in names), ";".join(names), payload])
        to_sign = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
        key = _sign(_sign(_sign(_sign(("AWS4" + self.secret_key).encode(), date), self.region), "s3"), "aws4_request")
        return hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest(), scope, ";".join(names)

    def presign(self, method, key, expires=3600, **extra):
        """Tarayicinin dogrudan R2'ye gidecegi sureli adres."""
        stamp = self._now().strftime("%Y%m%dT%H%M%SZ")
        query = {"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
                 "X-Amz-Credential": f"{self.access_key}/{stamp[:8]}/{self.region}/s3/aws4_request",
                 "X-Amz-Date": stamp, "X-Amz-Expires": str(expires), "X-Amz-SignedHeaders": "host",
                 **{k.replace("_", "-"): v for k, v in extra.items()}}
        path = self._path(key)
        signature, _, _ = self._signature(method, path, query, {"host": self.host}, UNSIGNED, stamp)
        query_text = "&".join(f"{_quote(k)}={_quote(v)}" for k, v in sorted(query.items()))
        return f"{self.endpoint}{path}?{query_text}&X-Amz-Signature={signature}"

    def _request(self, method, key="", body=None, query=None, extra_headers=None, timeout=60):
        query = query or {}
        stamp = self._now().strftime("%Y%m%dT%H%M%SZ")
        headers = {"host": self.host, "x-amz-date": stamp, "x-amz-content-sha256": UNSIGNED, **(extra_headers or {})}
        path = self._path(key)
        signature, scope, names = self._signature(method, path, query, headers, UNSIGNED, stamp)
        auth = f"AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, SignedHeaders={names}, Signature={signature}"
        query_text = "&".join(f"{_quote(k)}={_quote(v)}" for k, v in sorted(query.items()))
        url = f"{self.endpoint}{path}" + (f"?{query_text}" if query_text else "")
        send = {k: v for k, v in headers.items() if k != "host"}
        send["Authorization"] = auth
        return urllib.request.urlopen(urllib.request.Request(url, data=body, headers=send, method=method), timeout=timeout)

    def get(self, key):
        """Nesnenin icerigi. Yoksa None."""
        try:
            with self._request("GET", key) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise

    def get_text(self, key, default=""):
        data = self.get(key)
        return data.decode("utf-8") if data is not None else default

    def exists(self, key):
        try:
            with self._request("HEAD", key):
                return True
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return False
            raise

    def put(self, key, body, content_type="application/octet-stream"):
        body = body.encode("utf-8") if isinstance(body, str) else body
        with self._request("PUT", key, body=body, extra_headers={"content-type": content_type}, timeout=600):
            pass

    def put_file(self, key, path, content_type="application/octet-stream"):
        with open(path, "rb") as f:
            self.put(key, f.read(), content_type)

    def get_file(self, key, path):
        with self._request("GET", key, timeout=600) as response, open(path, "wb") as out:
            shutil.copyfileobj(response, out, 1024 * 1024)

    def delete(self, key):
        with self._request("DELETE", key):
            pass

    def list(self, prefix="", delimiter=""):
        """Doner: (anahtarlar, ortak onekler)."""
        keys, prefixes, token = [], [], None
        while True:
            query = {"list-type": "2", "prefix": prefix}
            if delimiter:
                query["delimiter"] = delimiter
            if token:
                query["continuation-token"] = token
            with self._request("GET", "", query=query) as response:
                root = ET.fromstring(response.read())
            ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
            keys += [e.findtext(f"{ns}Key") for e in root.findall(f"{ns}Contents")]
            prefixes += [e.findtext(f"{ns}Prefix") for e in root.findall(f"{ns}CommonPrefixes")]
            token = root.findtext(f"{ns}NextContinuationToken")
            if not token:
                return keys, prefixes

    def set_cors(self, origins):
        rules = "".join(f"<AllowedOrigin>{o}</AllowedOrigin>" for o in origins)
        xml = (f'<CORSConfiguration><CORSRule>{rules}<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod>'
               '<AllowedHeader>*</AllowedHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>')
        body = xml.encode()
        import base64
        md5 = base64.b64encode(hashlib.md5(body).digest()).decode()
        with self._request("PUT", "", body=body, query={"cors": ""}, extra_headers={"content-md5": md5, "content-type": "application/xml"}):
            pass
