import base64, zipfile, os

d = os.path.dirname(os.path.abspath(__file__))

png = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)
open(os.path.join(d, "image_0.png"), "wb").write(png)

with zipfile.ZipFile(os.path.join(d, "image_0.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("image_0.png", png)

print("fixtures ready: image_0.png (%d bytes), image_0.zip (%d bytes)"
      % (len(png), os.path.getsize(os.path.join(d, "image_0.zip"))))
