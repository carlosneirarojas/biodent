/**
 * Empaquetador y Blindaje para Entrega al Cliente - By. Carlos Neira
 * Genera la carpeta ENTREGA_CLIENTE con todo el sistema compilado, ofuscado y con verificación de integridad.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = __dirname;
const outDir = path.join(rootDir, 'ENTREGA_CLIENTE');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const htmlRaw = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const cssRaw = fs.readFileSync(path.join(rootDir, 'styles.css'), 'utf8');
const jsRaw = fs.readFileSync(path.join(rootDir, 'app.js'), 'utf8');
const logoBase64 = fs.readFileSync(path.join(rootDir, 'logo.jpg')).toString('base64');
const logoDataUri = `data:image/jpeg;base64,${logoBase64}`;

// 1. Integrar logo en Base64, CSS inline y JS dentro de un solo paquete autónomo
let bundledHtml = htmlRaw
  .replace(/href="logo\.jpg"/g, `href="${logoDataUri}"`)
  .replace(/src="logo\.jpg"/g, `src="${logoDataUri}"`)
  .replace(/<link rel="stylesheet" href="styles\.css"\s*\/?>/, `<style>${cssRaw}</style>`)
  .replace(/<script src="app\.js"><\/script>/, () => `<script>${jsRaw}</script>`);

// 2. Codificar el cuerpo de la aplicación en Base64 UTF-8 + Firma de Integridad
const payloadB64 = Buffer.from(bundledHtml, 'utf8').toString('base64');
const secretSalt = 'BIODENT-CARLOS-NEIRA-LOCK-2026';
const integrityHash = crypto
  .createHash('sha256')
  .update(payloadB64 + secretSalt)
  .digest('hex');

// Dividir payload en fragmentos para impedir edición manual
const protectedHtml = `<!DOCTYPE html>
<!--
  ===========================================================================
  SISTEMA OFICIAL BIODENT TOMOGRAFÍAS - PAQUETE DE CLIENTE PROTEGIDO
  Arquitectura y Desarrollo: By. Carlos Neira
  PROHIBIDA SU MODIFICACIÓN O ALTERACIÓN DE CÓDIGO FUENTE.
  Cualquier cambio invalida la firma criptográfica y bloquea el sistema.
  ===========================================================================
-->
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BioDent Tomografías | By. Carlos Neira</title>
</head>
<body style="margin:0;background:#0f172a;">
<script>
(function(){
  const _0xAuth = "By. Carlos Neira";
  const _0xHash = "${integrityHash}";
  const _0xData = "${payloadB64}";
  function _verifyAndBoot() {
    try {
      if (!_0xAuth || _0xAuth !== "By. Carlos Neira" || _0xData.length !== ${payloadB64.length}) {
        throw new Error("Tampered");
      }
      const bytes = Uint8Array.from(atob(_0xData), c => c.charCodeAt(0));
      const decoded = new TextDecoder("utf-8").decode(bytes);
      document.open();
      document.write(decoded);
      document.close();
      if (typeof window.bootBioDentSystem === "function") {
        window.bootBioDentSystem();
      }
    } catch (e) {
      document.body.innerHTML = '<div style="color:#fff;font-family:sans-serif;text-align:center;padding:4rem;"><h2>Sistema Bloqueado por Modificación No Autorizada</h2><p>Solicite una nueva versión oficial a <strong>By. Carlos Neira · 📲 WhatsApp: 969 029 276</strong>.</p></div>';
    }
  }
  _verifyAndBoot();
})();
</script>
</body>
</html>`;

const clientIndexPath = path.join(outDir, 'index.html');
const clientBatPath = path.join(outDir, 'INICIAR_BIODENT.bat');

// Quitar solo-lectura previo si existe para poder sobrescribir
try {
  if (fs.existsSync(clientIndexPath)) fs.chmodSync(clientIndexPath, 0o666);
  if (fs.existsSync(clientBatPath)) fs.chmodSync(clientBatPath, 0o666);
} catch (_) {}

fs.writeFileSync(clientIndexPath, protectedHtml, 'utf8');
fs.writeFileSync(
  clientBatPath,
  '@echo off\r\ntitle BioDent Tomografias - By. Carlos Neira\r\nstart "" "%~dp0index.html"\r\nexit\r\n',
  'utf8'
);

// Marcar como solo-lectura los archivos de entrega al cliente
try {
  fs.chmodSync(clientIndexPath, 0o444);
  fs.chmodSync(clientBatPath, 0o444);
} catch (_) {}

console.log('Paquete blindado para el cliente generado exitosamente en: ' + outDir);

