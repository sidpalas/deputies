import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getBlogPostUrl, getPublishedBlogPosts } from '../lib/blog';

export async function GET(context: APIContext) {
  const posts = await getPublishedBlogPosts();

  return rss({
    title: 'Deputies Blog',
    description: 'Notes on background agents, self-hostable agent infrastructure, and building Deputies.',
    site: context.site ?? 'https://deputies.dev',
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: getBlogPostUrl(post),
    })),
  });
}
