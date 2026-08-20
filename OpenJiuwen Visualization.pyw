"""Double-click launcher for OpenJiuwen Visualization on Windows."""

from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
SERVICE_SOURCE = PROJECT_ROOT / "services" / "local-server" / "src"
sys.path.insert(0, str(SERVICE_SOURCE))

from openjiuwen_visualization_server.companion import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(PROJECT_ROOT))
