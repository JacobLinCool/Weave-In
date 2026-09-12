import { ArrowRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import narrative from '../PROJECT-NARRATIVE.md?raw';
import { Brand } from './brand';

export function AboutPage() {
  return <div className="about-page">
    <header className="about-page__header">
      <a className="about-page__brand" href="/" aria-label="Weave In home"><Brand /></a>
      <nav aria-label="Page">
        <a href="/">Home</a>
        <a href="/about" aria-current="page">About</a>
      </nav>
    </header>
    <main className="about-page__content">
      <article className="about-page__article" aria-labelledby="about-title">
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ h1: ({ children }) => <h1 id="about-title">{children}</h1> }}>
          {narrative}
        </ReactMarkdown>
      </article>
      <footer className="about-page__footer">
        <a className="primary-button" href="/#start">Start a room <ArrowRight size={18} aria-hidden="true" /></a>
        <a className="about-page__home" href="/">Back to home</a>
      </footer>
    </main>
  </div>;
}
