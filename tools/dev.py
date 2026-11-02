"""源码开发入口：python -I -B tools/dev.py <CLI 参数>。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dev_notify.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
