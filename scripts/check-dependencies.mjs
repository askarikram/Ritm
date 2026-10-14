import { execFileSync } from 'node:child_process';
// Existing Render services also run npm run check, even when render.yaml is not reapplied.
if(process.env.NODE_ENV==='production'||process.env.RENDER_SERVICE_ID)execFileSync('npm',['audit','--omit=dev','--audit-level=low'],{stdio:'inherit'});
