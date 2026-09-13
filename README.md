# Cotizador Energy Sur SpA ⚡

Sistema web profesional de cotización de tableros eléctricos. Reemplaza la
planilla Excel manual con una herramienta SaaS/B2B: búsqueda inteligente de
productos (insensible a acentos, super/subíndices y con sinónimos),
cálculos en vivo (Neto → IVA 19% → Total en CLP), historial, PDF imprimible
con firma digital y envío por WhatsApp.

## Estructura

| Archivo      | Descripción                              |
|--------------|------------------------------------------|
| `index.html` | App completa (HTML+CSS+JS, sin build)    |
| `logo.png`   | Logo Energy Sur SpA (header + PDF)       |
| `vercel.json`| Config de deploy estático en Vercel      |

## Desarrollo local

Sin dependencias: abre `index.html` o sirve la carpeta:

```bash
npx serve .
```

## Regla de negocio (verificable)

```
línea = precio_unitario × cantidad   (enteros CLP)
neto  = Σ líneas
iva   = round(neto × tasa_iva)       (tasa parametrizable, default 19%)
total = neto + iva
```

Ejemplo: 35.500×2 + 50.000 + 23.000 → Neto 144.000 · IVA 27.360 · Total 171.360.

## Deploy

```bash
vercel --prod
```

Repo: https://github.com/Jochoa12/cotizador-energy-sur
