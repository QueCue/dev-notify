"""标准库 HTTPS 传输；不跟随重定向，不输出含凭据的地址或服务端正文。"""

import json
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TransportError(RuntimeError):
    pass


def request_json(url: str, payload: dict, *, form: bool = False, timeout: int = 10) -> dict:
    if form:
        body = urllib.parse.urlencode(payload).encode("utf-8")
        content_type = "application/x-www-form-urlencoded"
    else:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        content_type = "application/json"
    request = urllib.request.Request(url, data=body, headers={"Content-Type": content_type}, method="POST")
    opener = urllib.request.build_opener(NoRedirect())
    try:
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            if 300 <= error.code < 400:
                error.close()
                raise TransportError("拒绝重定向，未向其他地址发送凭据") from None
            response = error
        with response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise TransportError("服务端响应超过大小限制")
        result = json.loads(raw.decode("utf-8"))
        if not isinstance(result, dict):
            raise TransportError("服务端未返回 JSON 对象")
        return result
    except TransportError:
        raise
    except (OSError, ValueError, UnicodeError):
        raise TransportError("网络请求失败或响应无效；未自动重发，投递状态可能未知") from None
