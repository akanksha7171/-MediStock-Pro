import axios from 'axios';
const api=axios.create({baseURL:'/api'});
api.interceptors.request.use(c=>{const t=localStorage.getItem('token');if(t)c.headers.Authorization='Bearer '+t;return c;});
api.interceptors.response.use(r=>r,e=>{if(e.response?.status===401&&!e.config.url.includes('login')){localStorage.clear();location.href='/login';}return Promise.reject(e);});
export const msg=e=>e.response?.data?.error||'Could not reach the server. Please try again.';
export default api;
export const download=async(what)=>{const r=await api.get('/export/'+what,{responseType:'blob'});const a=document.createElement('a');a.href=URL.createObjectURL(r.data);a.download=what+'.csv';a.click();};
