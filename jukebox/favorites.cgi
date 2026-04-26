#!/usr/bin/env python3
import json
import os
import sys
import cgi
import cgitb

# CGIエラーをブラウザ上で表示可能にする
cgitb.enable()

# 保存先ディレクトリの指定
USER_DATA_DIR = './user_data'

def respond_json(data, status_num=200):
    status_map = {200: "200 OK", 400: "400 Bad Request", 405: "405 Method Not Allowed", 500: "500 Internal Server Error"}
    status_text = status_map.get(status_num, f"{status_num} Unknown")
    
    print(f"Status: {status_text}")
    print("Content-Type: application/json; charset=utf-8")
    print("Cache-Control: no-cache, no-store, must-revalidate")
    print("")
    print(json.dumps(data, indent=2))
    sys.stdout.flush()
    sys.exit(0)

def main():
    # 1. フォルダの準備
    if not os.path.exists(USER_DATA_DIR):
        try:
            os.makedirs(USER_DATA_DIR, exist_ok=True)
            # サーバー環境によってはパーミッション調整が必要な場合がある
            os.chmod(USER_DATA_DIR, 0o777)
        except Exception as e:
            respond_json({"error": "Failed to create user_data directory", "details": str(e)}, 500)

    # 2. リクエストのパース
    if os.environ.get('REQUEST_METHOD') != 'POST':
        respond_json({"error": "Only POST method is allowed"}, 405)

    try:
        content_length = int(os.environ.get('CONTENT_LENGTH', 0))
        if content_length > 0:
            post_data = sys.stdin.read(content_length)
            body = json.loads(post_data)
        else:
            body = {}
    except Exception as e:
        respond_json({"error": "Invalid JSON body", "details": str(e)}, 400)

    action = body.get('action')
    username = body.get('username')

    if not username:
        respond_json({"error": "Username is required"}, 400)

    # ファイル名の安全な正規化 (ディレクトリトラバーサル防止)
    # 英数字、スペース、ハイフン、アンダースコアのみを許可
    safe_username = "".join([c for c in username if c.isalnum() or c in (' ', '-', '_')]).strip()
    if not safe_username:
        safe_username = "unknown_user"
    
    filename = os.path.join(USER_DATA_DIR, f"{safe_username} favorites.json")

    # 3. アクションの実行
    if action == 'load':
        if os.path.exists(filename):
            try:
                with open(filename, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                respond_json(data)
            except Exception as e:
                respond_json({"error": "Failed to read favorites file", "details": str(e)}, 500)
        else:
            # ファイルがなければ空のチャートを返す
            respond_json({"chart_artist": username, "chart_title": "My Favorites", "chart": []})

    elif action == 'save':
        data = body.get('data')
        if data is None:
            respond_json({"error": "Data is required for save action"}, 400)
        
        try:
            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            # パーミッションを適切に設定
            os.chmod(filename, 0o666)
            respond_json({"status": "success", "file": os.path.basename(filename)})
        except Exception as e:
            respond_json({"error": "Failed to write favorites file", "details": str(e)}, 500)

    else:
        respond_json({"error": "Invalid action. Use 'load' or 'save'."}, 400)

if __name__ == "__main__":
    main()
