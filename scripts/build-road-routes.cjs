const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (input.code !== 'Ok' || input.routes[0].legs.length !== 8) throw new Error('Unexpected route response');
const groups=[[0],[1],[2,3],[4],[5,6],[7]];
const legs=groups.map(indices=>indices.reduce((leg,index)=>{
  const part=input.routes[0].legs[index];
  leg.distance+=part.distance;leg.duration+=part.duration;leg.steps.push(...part.steps);return leg;
},{distance:0,duration:0,steps:[]}));
const result = {
  provider: 'OSRM / OpenStreetMap',
  retrieved: '2026-09-08',
  waypoints: input.waypoints.map(p => ({ coordinates: p.location, snapDistance: p.distance })),
  legs: legs.map(leg => ({
    distance: leg.distance,
    duration: leg.duration,
    coordinates: leg.steps.flatMap(step => step.geometry.coordinates),
    roads: [...new Set(leg.steps.map(step => step.ref || step.name).filter(Boolean))]
  }))
};
fs.writeFileSync('data/hailar-road-routes.js', `// Road geometry from OSRM, based on OpenStreetMap (ODbL).\nwindow.roadRoutes = ${JSON.stringify(result)};\n`);
