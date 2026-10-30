"""Static server for the simulator without browser caching: python3 serve.py [root] [host] [port]
(default: current directory on 127.0.0.1:8765; host 0.0.0.0 makes it reachable from the local network)."""
import functools
import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


root = sys.argv[1] if len(sys.argv) > 1 else '.'
host = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'
port = int(sys.argv[3]) if len(sys.argv) > 3 else 8765
http.server.ThreadingHTTPServer((host, port), functools.partial(NoCache, directory=root)).serve_forever()
