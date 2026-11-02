import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const dir = process.cwd();
http.createServer(async (req,res)=>{
  try{
    const name = decodeURIComponent(req.url.slice(1));
    const buf = await readFile(join(dir, name));
    res.writeHead(200,{'content-type':'image/jpeg','access-control-allow-origin':'*'});
    res.end(buf);
  }catch(e){ res.writeHead(404); res.end('no'); }
}).listen(6200, ()=>console.log('shots on 6200'));
