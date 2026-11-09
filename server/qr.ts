import QRCode from "qrcode";

/** 把文本编成 PNG data URI，客户端直接用 Image 渲染。 */
export async function toQrDataUri(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 512,
  });
}
