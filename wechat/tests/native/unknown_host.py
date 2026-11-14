"""Owned child-process fixture for unknown submission and owner-lifetime tests."""
import json
from pathlib import Path
import sys

from PIL import Image

from test_worker import ACCOUNT, TARGET, RecordingTransport, worker


def main():
    state, media = (Path(value).resolve() for value in sys.argv[1:3])
    host = worker.Worker(ACCOUNT, state, media, state.parent / 'engine', allow_native=True)
    try:
        source = media / 'child.png'
        with Image.new('RGB', (2, 2), 'blue') as image:
            image.save(source)
        asset = host.prepare_image({'targetId': TARGET, 'path': str(source)})
        host.native = RecordingTransport(state / 'state.sqlite3', 'timeout')
        host.targets = frozenset({TARGET})
        result = host.dispatch('submit_text', {'requestId': '1234abcd1234abcd1234abcd1234abcd', 'targetId': TARGET, 'text': '中文🙂'})
        print(json.dumps({**result, 'snapshot': asset['assetId'] + '.png'}), flush=True)
        sys.stdin.readline()
    finally:
        host.close({})


if __name__ == '__main__':
    main()
