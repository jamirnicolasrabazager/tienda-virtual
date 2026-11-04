# Tienda virtual · JG

Tienda virtual en español con catálogo, carrito, pedidos por WhatsApp, autenticación Supabase, puntos/cashback, panel administrativo, promociones y seguimiento de pedidos.

## Tecnologías

- Node.js 22 y Express 4 para la API.
- PostgreSQL de Supabase para productos, configuración, perfiles, pedidos, movimientos y promociones.
- Supabase Auth para registro e inicio de sesión.
- Supabase Storage para imágenes de productos y QR.
- HTML, CSS y JavaScript sin proceso de compilación para el frontend.
- Vercel para desplegar la página estática y la API serverless.

## Configuración en Vercel

En **Project → Settings → Environment Variables**, conserva los valores existentes y verifica que estén configuradas estas variables:

| Variable | Uso |
|---|---|
| `DATABASE_URL` | Cadena de conexión PostgreSQL de Supabase. |
| `SUPABASE_URL` | URL del proyecto Supabase. |
| `SUPABASE_ANON_KEY` | Clave pública/anon de Supabase, usada por el servidor para Auth. |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave privada de servicio. Solo servidor; nunca ponerla en `index.html`. |
| `ADMIN_EMAILS` | Correos autorizados para administrar la tienda, separados por comas. |
| `SUPABASE_BUCKET` | Bucket de Storage; por defecto `productos`. |

Opcionales: `CORS_ORIGINS` para permitir otros dominios de frontend, `PG_POOL_MAX` para ajustar el pool PostgreSQL y `PORT` para desarrollo local.

**Importante:** las claves no forman parte de este repositorio. No las pegues en el código ni las subas a GitHub. El archivo `.env.example` contiene solo nombres y marcadores. Si las variables ya están en Vercel, mantenlas; no hace falta reemplazar las claves.

## Desarrollo local

1. Instala Node.js 22.
2. Copia `.env.example` como `.env` y completa los valores con los que ya usa tu proyecto.
3. Instala dependencias con `npm install`.
4. Ejecuta las comprobaciones con `npm run check`.
5. Inicia la API con `npm start` y abre `http://localhost:3000`.

La API crea las tablas que necesita y aplica migraciones aditivas al iniciar. Los productos, clientes, pedidos y configuraciones existentes se conservan. Las nuevas tablas/columnas de promociones y descuentos se añaden sin borrar datos.

## Despliegue en GitHub y Vercel

1. Sube el contenido del proyecto a tu repositorio GitHub, sin incluir `.env`.
2. En Vercel, importa el repositorio y deja la configuración de `vercel.json`.
3. Configura las variables de entorno indicadas arriba en los entornos Preview y Production que correspondan.
4. Despliega. Vercel publica `index.html` como página estática y `api/index.js` como función Node.

Si tu frontend y API usan dominios distintos, agrega el origen exacto del frontend a `CORS_ORIGINS`, separado por comas. En el caso normal de una tienda alojada en el mismo dominio, déjalo vacío.

## Funciones añadidas

- Búsqueda y ordenamiento del catálogo por fecha, precio y nombre.
- Seguimiento de pedido con código y últimos cuatro dígitos del teléfono.
- Códigos de promoción por porcentaje o monto fijo, compra mínima, límite de usos y vencimiento.
- Aplicación del cupón recalculada y validada en el servidor al crear el pedido.
- Estadísticas de ventas, pedidos pendientes/confirmados/cancelados, ticket promedio e ingresos de los últimos siete días.
- Gestión administrativa para crear, activar, desactivar y eliminar promociones.
- Cabeceras de seguridad, validación de configuración, CORS restringido y limitación básica de solicitudes.

## Notas de seguridad

- `SUPABASE_SERVICE_ROLE_KEY` tiene privilegios elevados y debe permanecer únicamente en variables de entorno del servidor.
- Las rutas administrativas verifican el JWT de Supabase y el correo incluido en `ADMIN_EMAILS`.
- El limitador de solicitudes incluido funciona por instancia; en despliegues de alto tráfico conviene complementarlo con límites distribuidos del proveedor o un WAF.
- Los descuentos, precios y puntos se vuelven a calcular en el backend; los valores del navegador no se consideran fuente de verdad.


## Mejoras de atención y experiencia del cliente (v2.1)

- Barra lateral fija para abrir atención por WhatsApp, historial de pedidos, promociones y redes sociales. En pantallas pequeñas se transforma en una barra inferior.
- El bloque de seguimiento se retiró de debajo del catálogo. Para clientes invitados, la consulta por código y últimos cuatro dígitos del teléfono está dentro de **Mis pedidos**.
- Los clientes con sesión pueden ver hasta sus últimos 100 pedidos vinculados a su propia cuenta. Los estados se presentan como **Por confirmar pago**, **Por entregar**, **Completado** o **Cancelado**.
- Las promociones permiten definir fecha y hora de inicio y vencimiento. Se muestran también las promociones programadas; los cupones futuros no se aceptan hasta su fecha de inicio.
- El panel admin permite editar todos los campos principales de un producto y administrar su galería (hasta 8 imágenes). También permite editar datos de contacto de un pedido, notas internas y adjuntar hasta 8 imágenes/evidencias.
- Tallas y colores se representan en selectores independientes. Para conservar nombres de colores de varias palabras, sepáralos con coma, punto y coma o salto de línea. Las tallas antiguas separadas por espacios (por ejemplo `2XL 3XL`) ahora se interpretan como opciones diferentes.

## Migraciones aditivas v2.1

Al iniciar la API se añaden, si faltan, `tienda_promociones.inicia_en`, `tienda_pedidos.nota_admin` y `tienda_pedidos.imagenes`. No se eliminan ni se reemplazan columnas o datos existentes. La migración se ejecuta automáticamente con la conexión PostgreSQL configurada en `DATABASE_URL`.

Los pedidos hechos **con sesión iniciada** quedan asociados al perfil y aparecen en **Mis pedidos**. Los pedidos hechos como invitado pueden consultarse desde esa misma interfaz con el código JG y los últimos cuatro dígitos del celular.

## Verificaciones realizadas para esta entrega

Ejecuta `npm run check` para verificar sintaxis de la API y del frontend, IDs duplicados y referencias literales a elementos HTML. Estas verificaciones locales no sustituyen una prueba de integración con las credenciales reales de Supabase/PostgreSQL ni una implementación de prueba en Vercel.
