#!/usr/bin/env python3
import json
import os
import sys
import urllib.request
import urllib.parse
import cgi
import cgitb

# CGIエラーをブラウザ上で表示可能にする（テスト中のみ推奨）
cgitb.enable()

# クライアント秘密情報のパス（.htaccess 等の環境変数から取得。なければ None）
SECRET_FILE = os.environ.get('JUKEBOX_SECRET_PATH')

def get_credentials():
    if not SECRET_FILE:
        respond_json({"error": "Configuration Error", "details": "Secret path not configured in environment"}, 500)
    try:
        with open(SECRET_FILE, 'r') as f:
            data = json.load(f)
            return data['web']
    except Exception as e:
        respond_json({"error": "Failed to read secret file", "details": str(e)}, 500)

def respond_json(data, status_num=200):
    status_map = {200: "200 OK", 400: "400 Bad Request", 405: "405 Method Not Allowed", 500: "500 Internal Server Error"}
    status_text = status_map.get(status_num, f"{status_num} Unknown")
    
    print(f"Status: {status_text}")
    print("Content-Type: application/json; charset=utf-8")
    print("Cache-Control: no-cache, no-store, must-revalidate")
    print("Pragma: no-cache")
    print("Expires: 0")
    print("")
    print(json.dumps(data, indent=2))
    sys.stdout.flush()
    sys.exit(0)

def exchange_code(code, creds):
    url = "https://oauth2.googleapis.com/token"
    params = {
        "code": code,
        "client_id": creds['client_id'],
        "client_secret": creds['client_secret'],
        "redirect_uri": "postmessage",
        "grant_type": "authorization_code"
    }
    return make_google_request(url, params)

def refresh_token(refresh_token_val, creds):
    url = "https://oauth2.googleapis.com/token"
    params = {
        "refresh_token": refresh_token_val,
        "client_id": creds['client_id'],
        "client_secret": creds['client_secret'],
        "grant_type": "refresh_token"
    }
    return make_google_request(url, params)

def make_google_request(url, params):
    data = urllib.parse.urlencode(params).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST')
    try:
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8')
        try:
            err_json = json.loads(err_body)
            return {"error": "Google API Error", "details": err_json, "status": e.code}
        except:
            return {"error": "Google API Error", "details": err_body, "status": e.code}
    except Exception as e:
        return {"error": "Network Error", "details": str(e)}

def main():
    # POSTデータの受け取り
    if os.environ.get('REQUEST_METHOD') != 'POST':
        respond_json({"error": "Only POST method is allowed"}, 405)

    try:
        # JSONボディのパース
        content_length = int(os.environ.get('CONTENT_LENGTH', 0))
        if content_length > 0:
            post_data = sys.stdin.read(content_length)
            body = json.loads(post_data)
        else:
            body = {}
    except Exception as e:
        respond_json({"error": "Invalid JSON body", "details": str(e)}, 400)

    action = body.get('action')
    creds = get_credentials()

    if action == 'exchange':
        code = body.get('code')
        if not code:
            respond_json({"error": "Code is required for exchange"}, 400)
        result = exchange_code(code, creds)
        if "error" in result and result.get("error") != "Google API Error":
            respond_json(result, 500)
        respond_json(result)

    elif action == 'refresh':
        rt = body.get('refresh_token')
        if not rt:
            respond_json({"error": "Refresh token is required for refresh"}, 400)
        result = refresh_token(rt, creds)
        if "error" in result and result.get("error") != "Google API Error":
            respond_json(result, 500)
        respond_json(result)

    else:
        respond_json({"error": "Invalid action"}, 400)

if __name__ == "__main__":
    main()
