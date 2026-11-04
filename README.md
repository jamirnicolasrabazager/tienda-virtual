# Tienda virtual · JG

Tienda virtual en español con catálogo, carrito, pedidos por WhatsApp, autenticación Supabase, puntos/cashback, panel administrativo, stock por talla/color, promociones públicas y privadas, y analítica de ganancias.

## Tecnologías

- Node.js 22 y Express 4 para la API.
- PostgreSQL de Supabase para productos, configuración, perfiles, pedidos, movimientos, promociones e inventario por variante.
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

La API crea las tablas que necesita y aplica migraciones al iniciar. Los productos, clientes, pedidos y configuraciones existentes se conservan. Las promociones anteriores se actualizan para dejar su compra mínima en cero; no se elimina ninguna promoción.

## Despliegue en GitHub y Vercel

1. Sube el contenido del proyecto a tu repositorio GitHub, sin incluir `.env`.
2. En Vercel, importa el repositorio y deja la configuración de `vercel.json`.
3. Configura las variables de entorno indicadas arriba en los entornos Preview y Production que correspondan.
4. Despliega. Vercel publica `index.html` como página estática y `api/index.js` como función Node.

Si tu frontend y API usan dominios distintos, agrega el origen exacto del frontend a `CORS_ORIGINS`, separado por comas. En el caso normal de una tienda alojada en el mismo dominio, déjalo vacío.

## Funciones añadidas

- Búsqueda y ordenamiento del catálogo por fecha, precio y nombre.
- Seguimiento de pedido con código y últimos cuatro dígitos del teléfono.
- Códigos promocionales personalizados por porcentaje o monto fijo, sin compra mínima; límite de usos y fechas de vigencia son opcionales.
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


## Inventario y cálculo de ganancias (v2.2)

- La pestaña **Stock / inventario** permite registrar unidades disponibles y costo unitario para cada combinación de producto, talla y color.
- Antes de confirmar una venta nueva, registra el stock y costo de todos sus productos en esta pestaña; el servidor no permite confirmar un artículo sin control de inventario configurado. Al pasar un pedido de **pendiente** a **pagado** (o directamente a **entregado**), el servidor bloquea las filas de inventario necesarias, comprueba existencias, registra el costo histórico de cada línea y descuenta las unidades en una transacción. Cambiar después de **pagado** a **entregado** no descuenta otra vez.
- Si se cancela un pedido que ya había descontado inventario, las unidades se reintegran una sola vez. Si no hay existencias suficientes, la confirmación se rechaza y la transacción se revierte.
- Configura el stock físico actual de cada variante antes de confirmar nuevas ventas. Los pedidos ya completados antes de activar el inventario no modifican el stock retroactivamente. Los pedidos históricos sin costo guardado se excluyen de las ganancias calculadas y se muestran como pedidos sin costo completo.
- **Ganancia bruta** = subtotal del pedido − costo histórico de los productos. **Ganancia neta** = total cobrado (ya descuenta cupones y puntos utilizados) − cashback concedido − costo histórico de los productos. No incluye comisiones bancarias, impuestos ni otros gastos externos que no estén registrados en el sistema.
- Los códigos promocionales pueden ser **públicos** (aparecen en la pestaña de promociones de la tienda) o **privados** (no se publican; se aplican únicamente cuando el cliente conoce e introduce el código). No exigen compra mínima; las fechas de vigencia y el límite de usos son opcionales.
- El texto para WhatsApp ahora incluye un comprobante organizado con código, fecha, variantes, importes, descuentos, total y datos del cliente.

La migración v2.2 añade `tienda_productos.stock_controlado`, la tabla `tienda_stock_variantes`, los indicadores `tienda_pedidos.stock_deducido` / `stock_reintegrado` y `tienda_promociones.publica`. Se ejecuta automáticamente al iniciar la API y no elimina productos, pedidos, clientes, promociones ni configuraciones existentes.


## Separación de inventario y finanzas (v2.3)

- El panel administrativo dispone de una pestaña dedicada **Stock e inventario** y otra pestaña independiente **Ganancias y finanzas**. El historial de compras queda enfocado exclusivamente en la revisión y gestión de pedidos.
- La pantalla de inventario lista todos los productos del catálogo con su imagen, precio de venta, variantes, control de stock, unidades disponibles y estado de configuración de costos. Desde cada fila se abre el editor de cantidades y costos por combinación de talla/color.
- El costo de adquisición permanece exclusivamente en rutas administrativas protegidas; no se incluye en el catálogo público ni en las respuestas de promociones o pedidos que reciben los clientes. El costo se gestiona por variante para que los reportes reflejen diferencias reales entre tallas o colores.
- El módulo financiero independiente muestra ingresos cobrados, costo histórico de productos, ganancia bruta, cashback reconocido y ganancia neta, además del gráfico de los últimos siete días.
- La pestaña pública de promociones se actualiza al abrirla y cuenta con un botón manual de actualización. Después de crear, activar, desactivar, hacer pública/privada o eliminar una promoción en administración, la vista pública se refresca automáticamente si está abierta. Las solicitudes a este endpoint se envían sin caché.
- El endpoint administrativo de inventario devuelve nombre, imagen y precio de los productos junto con las variantes y costos; continúa protegido mediante `requiereAdmin`. El endpoint público `/api/productos` no expone costos de adquisición.

## Códigos promocionales personalizados sin mínimo de compra (v2.3.1)

- El administrador define el código; se normalizan tildes y espacios (por ejemplo, “NAVIDAD 2026” se guarda como `NAVIDAD-2026`).
- No existe compra mínima: el descuento se puede aplicar a cualquier pedido con artículos.
- El límite de usos y las fechas de vigencia siguen siendo opcionales.



Las comprobaciones locales (`npm run check`) validan sintaxis del backend y frontend, IDs estáticos duplicados y referencias literales. La prueba real de flujos de compra, permisos y persistencia requiere las variables de entorno y la base PostgreSQL/Supabase del despliegue.


## Exclusión y retiro de pedidos (v2.3.2)

- En **Historial de compras**, el botón **Borrar pedido** excluye el pedido de los resúmenes financieros, ingresos y gráficos de ganancias brutas/netas. El pedido sigue visible en el historial administrativo con la marca **Excluido de finanzas**.
- Después aparece **Quitar de registro**. Al utilizarlo, el pedido deja de mostrarse en el historial administrativo. El registro se conserva internamente para mantener la trazabilidad; tampoco se alteran el inventario ni los puntos/cashback del cliente.
- La API añade automáticamente las columnas `tienda_pedidos.excluido_finanzas` y `tienda_pedidos.oculto_registro` si todavía no existen. Los pedidos actuales quedan incluidos en estadísticas por defecto.
