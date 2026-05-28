import { getCollection, type CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;

const dateFormatter = new Intl.DateTimeFormat('en', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export async function getPublishedBlogPosts(): Promise<BlogPost[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  assertUniqueBlogPostSlugs(posts);
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export function getBlogPostSlug(post: BlogPost): string {
  const segments = post.id.split('/');
  const lastSegment = segments.at(-1) ?? post.id;

  if (lastSegment === 'index' && segments.length > 1) {
    return segments.at(-2) ?? lastSegment;
  }

  return lastSegment;
}

export function getBlogPostUrl(post: BlogPost): string {
  return `/blog/${getBlogPostSlug(post)}/`;
}

export function formatBlogDate(date: Date): string {
  return dateFormatter.format(date);
}

function assertUniqueBlogPostSlugs(posts: BlogPost[]): void {
  const idsBySlug = new Map<string, string>();

  for (const post of posts) {
    const slug = getBlogPostSlug(post);
    const existingId = idsBySlug.get(slug);

    if (existingId) {
      throw new Error(`Duplicate published blog slug "${slug}" for ${existingId} and ${post.id}.`);
    }

    idsBySlug.set(slug, post.id);
  }
}
