#!/usr/bin/env bash
# 生成 Tauri 所需的占位图标。优先用 `tauri icon`；否则用 Python(Pillow) 造一张源图再切。
set -euo pipefail
cd "$(dirname "$0")/.."

ICON_DIR="src-tauri/icons"
mkdir -p "$ICON_DIR"
SRC="$ICON_DIR/source.png"

# 用 Python 生成一张 1024x1024 纯色源图（深蓝底 + 圆角占位）。
python3 - "$SRC" <<'PY'
import sys
try:
    from PIL import Image, ImageDraw
except Exception:
    # 退化：写一个最小 1x1 PNG
    import struct, zlib, sys
    def chunk(t,d):
        return struct.pack(">I",len(d))+t+d+struct.pack(">I",zlib.crc32(t+d)&0xffffffff)
    raw=b"\x00"+b"\x1f\x3a\x5a"  # 1px RGB
    png=b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",1,1,8,2,0,0,0))+chunk(b"IDAT",zlib.compress(raw))+chunk(b"IEND",b"")
    open(sys.argv[1],"wb").write(png)
    sys.exit(0)
img=Image.new("RGBA",(1024,1024),(23,30,46,255))
d=ImageDraw.Draw(img)
d.rounded_rectangle([160,160,864,864],radius=120,fill=(56,120,220,255))
d.text((430,470),"DB",fill=(255,255,255,255))
img.save(sys.argv[1])
PY

if command -v pnpm >/dev/null 2>&1 && [ -f node_modules/.bin/tauri ]; then
  pnpm tauri icon "$SRC"
  echo "✓ 已通过 tauri icon 生成全套图标"
  exit 0
fi

# 无 tauri CLI：用 Python 生成各尺寸 PNG + ico/icns 占位。
python3 - "$SRC" "$ICON_DIR" <<'PY'
import sys
src, out = sys.argv[1], sys.argv[2]
try:
    from PIL import Image
except Exception:
    print("• 未安装 Pillow，且无 tauri CLI；请运行 'pnpm tauri icon src-tauri/icons/source.png'")
    sys.exit(0)
im = Image.open(src).convert("RGBA")
for name,size in [("32x32.png",32),("128x128.png",128),("128x128@2x.png",256),("icon.png",512)]:
    im.resize((size,size)).save(f"{out}/{name}")
im.resize((256,256)).save(f"{out}/icon.ico", sizes=[(256,256),(128,128),(64,64),(32,32),(16,16)])
try:
    im.resize((512,512)).save(f"{out}/icon.icns")
except Exception:
    # icns 可能不被支持；复制 png 占位（Tauri 在 mac 上需要真 icns，CI 中再用 tauri icon 重生成）
    im.resize((512,512)).save(f"{out}/icon.icns.png")
print("✓ 已生成占位图标（建议安装依赖后用 'pnpm tauri icon' 重新生成正式图标）")
PY
