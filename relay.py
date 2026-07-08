"""
WuzAPI Webhook Relay — bridges webhook events to the frontend.
Receives webhook POSTs from WuzAPI, stores messages in memory,
and exposes GET endpoints for the chat UI to poll.
"""
import json
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# In-memory storage: { jid: [ {id, fromMe, text, timestamp, status}, ... ] }
messages_store = {}
messages_lock = threading.Lock()
INITIAL_WINDOW_MS = 3 * 60 * 60 * 1000  # 3 hours

# Stats
contact_updates = {}  # { jid: { lastMsg, lastTime, unread } }


class RelayHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        """Receive webhooks from WuzAPI"""
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return

        event = data.get('event', '')
        payload = data.get('data', data)

        if event == 'Message':
            self._handle_message(payload)
        elif event == 'HistorySync':
            self._handle_history_sync(payload)

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({'ok': True}).encode())

    def do_GET(self):
        """Serve messages to the frontend"""
        parsed = urlparse(self.path)

        if parsed.path == '/messages':
            self._serve_messages(parsed)
        elif parsed.path == '/health':
            self._serve_json({'status': 'ok'})
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _handle_message(self, payload):
        """Parse WuzAPI message webhook payload"""
        try:
            info = payload.get('Info', payload)
            message = payload.get('Message', payload)
            msg_source = info.get('MessageSource', {})

            jid = msg_source.get('Chat', '') or msg_source.get('Sender', '')
            text = message.get('Conversation', '') or message.get('ExtendedTextMessage', {}).get('Text', '') or ''
            msg_id = info.get('ID', str(time.time()))
            timestamp = info.get('Timestamp', '')
            from_me = msg_source.get('IsFromMe', False)
            sender = msg_source.get('Sender', '')
            push_name = msg_source.get('PushName', '')

            if not jid or not text:
                return

            msg_obj = {
                'id': msg_id,
                'fromMe': from_me,
                'text': text,
                'timestamp': timestamp or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'jid': sender or jid,
                'status': 'read' if from_me else 'delivered',
                'pushName': push_name,
            }

            with messages_lock:
                if jid not in messages_store:
                    messages_store[jid] = []
                # Deduplicate
                if not any(m['id'] == msg_id for m in messages_store[jid]):
                    messages_store[jid].append(msg_obj)
                    # Sort by timestamp
                    messages_store[jid].sort(key=lambda m: m['timestamp'])

                # Update contact info
                contact_updates[jid] = {
                    'lastMsg': text,
                    'lastTime': timestamp or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                    'pushName': push_name,
                }

            print(f"[MSG] {'OUT' if from_me else 'IN'} | {push_name or jid}: {text[:80]}")
        except Exception as e:
            print(f"[ERR] Failed to handle message: {e}")

    def _handle_history_sync(self, payload):
        """Parse WuzAPI HistorySync webhook payload — batch of recent messages"""
        try:
            # HistorySync can come in different shapes. Try common patterns.
            conversations = payload.get('Conversations', payload.get('conversations', []))
            if not conversations:
                # Maybe it's a flat list of messages
                raw_msgs = payload.get('Messages', payload.get('messages', []))
                for msg in raw_msgs:
                    self._handle_message(msg)
                return

            for conv in conversations:
                jid = conv.get('JID', conv.get('jid', ''))
                messages = conv.get('Messages', conv.get('messages', []))
                for msg in messages:
                    msg['Chat'] = msg.get('Chat', jid)
                    self._handle_message(msg)
            print(f"[HISTORY] Processed {len(conversations)} conversations from HistorySync")
        except Exception as e:
            print(f"[ERR] Failed to handle HistorySync: {e}")

    def _serve_messages(self, parsed):
        """GET /messages?jid=... — return messages within the 3-hour window"""
        params = parse_qs(parsed.query)
        jid = params.get('jid', [''])[0]

        if not jid:
            self._serve_json([])
            return

        cutoff = int(time.time() * 1000) - INITIAL_WINDOW_MS

        with messages_lock:
            all_msgs = messages_store.get(jid, [])
            recent = [
                m for m in all_msgs
                if _timestamp_ms(m['timestamp']) > cutoff
            ]

        self._serve_json(recent)

    def _serve_json(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        """Suppress default logging"""
        pass


def _timestamp_ms(ts):
    """Convert timestamp string to epoch milliseconds"""
    try:
        # ISO format
        if 'T' in ts:
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            return int(dt.timestamp() * 1000)
        # Unix timestamp
        return int(float(ts) * 1000) if '.' in str(ts) else int(ts) * 1000
    except:
        return 0


def main():
    port = 3100
    server = HTTPServer(('127.0.0.1', port), RelayHandler)
    print(f"[Relay] WuzAPI Webhook Relay running on http://127.0.0.1:{port}")
    print(f"        Webhook URL: http://127.0.0.1:{port}/webhook")
    print(f"        Messages:    http://127.0.0.1:{port}/messages?jid=...")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
        print("\nRelay stopped.")


if __name__ == '__main__':
    main()
