const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png'};
const server=http.createServer((req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const name=decodeURIComponent(url.pathname)==='/'?'/index.html':decodeURIComponent(url.pathname);
    const file=path.resolve(root,'.'+name);
    if(!file.startsWith(root+path.sep)||name.split('/').some(s=>s.startsWith('.'))||!types[path.extname(file)]){res.writeHead(404);res.end();return;}
    fs.readFile(file,(error,data)=>{
      if(error){res.writeHead(404);res.end('Not found');return;}
      res.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-store'});res.end(data);
    });
  }catch{res.writeHead(400);res.end();}
});
server.listen(Number(process.env.TIBET_PORT)||4173,'127.0.0.1',()=>console.log(`Tibet guide: http://127.0.0.1:${server.address().port}/`));
