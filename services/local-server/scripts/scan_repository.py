from __future__ import annotations

import sys
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT / "src"))

from openjiuwen_visualization_server.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(["scan", *sys.argv[1:]]))
