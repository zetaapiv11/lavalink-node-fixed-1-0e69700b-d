'use client';
export default function ErrorPage({reset}:{reset:()=>void}){return <section className="panel error-page"><h1>Halaman belum dapat dimuat.</h1><p>Silakan coba lagi. Jika masih gagal, periksa status layanan.</p><button className="button" onClick={reset}>Coba lagi</button></section>;}
