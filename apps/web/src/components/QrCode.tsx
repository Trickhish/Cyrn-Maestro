import { useEffect, useState } from "react";
import QRCode from "qrcode";

/* A QR code for an otpauth:// URI.
 *
 * Rendered in the browser rather than fetched from anywhere: the payload
 * contains the TOTP secret, and handing it to a third-party chart service —
 * which is the usual shortcut — would give someone else the ability to
 * generate valid second factors.
 *
 * Two details decide whether a phone can actually read it. The polarity has to
 * be dark modules on a light ground, so the symbol keeps a white background
 * even in the dark theme; and the quiet zone around it has to survive, or
 * scanners cannot find the symbol at all. */

export function QrCode({ value, size = 168 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    QRCode.toDataURL(value, {
      /* Rendered at twice the display size so it stays sharp on a high-density
         screen, which is what most people will point a camera at. */
      width: size * 2,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#0a0f17", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [value, size]);

  /* The secret is always shown as text beside this, so a failure here is an
     inconvenience rather than a dead end. */
  if (failed || !dataUrl) {
    return (
      <div
        className="grid place-items-center rounded-lg border rule bg-surface text-center text-[11.5px] leading-snug text-faint"
        style={{ width: size, height: size }}
      >
        {failed ? "Enter the secret by hand" : ""}
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt="QR code for setting up two-factor authentication"
      width={size}
      height={size}
      className="rounded-lg bg-white p-2"
      style={{ width: size, height: size }}
    />
  );
}
