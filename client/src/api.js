// import axios from 'axios';
// const api=axios.create({baseURL:'/api'});
// api.interceptors.request.use(c=>{const t=localStorage.getItem('token');if(t)c.headers.Authorization='Bearer '+t;return c;});
// api.interceptors.response.use(r=>r,e=>{if(e.response?.status===401&&!e.config.url.includes('login')){localStorage.clear();location.href='/login';}return Promise.reject(e);});
// export const msg=e=>e.response?.data?.error||'Could not reach the server. Please try again.';
// export default api;
// export const download=async(what)=>{const r=await api.get('/export/'+what,{responseType:'blob'});const a=document.createElement('a');a.href=URL.createObjectURL(r.data);a.download=what+'.csv';a.click();};



import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error.response?.status === 401 &&
      !error.config?.url?.includes('login')
    ) {
      localStorage.clear();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const msg = (error) =>
  error.response?.data?.error || 'Could not reach the server. Please try again.';

export const download = async (what) => {
  const response = await api.get(`/export/${what}`, {
    responseType: 'blob',
  });

  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${what}.csv`;
  link.click();
  URL.revokeObjectURL(url);
};

export default api;