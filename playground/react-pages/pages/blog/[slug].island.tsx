type Props = {
  post: { slug: string; title: string; body: string };
};

export default function BlogPost({ post }: Props) {
  return (
    <div>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
      <a href="/blog">&larr; Back to Blog</a>
    </div>
  );
}
