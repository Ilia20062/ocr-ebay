-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- updated_at trigger function
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Apply updated_at trigger to all relevant tables
CREATE TRIGGER profiles_updated_at         BEFORE UPDATE ON profiles         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ebay_connections_updated_at BEFORE UPDATE ON ebay_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER upload_batches_updated_at   BEFORE UPDATE ON upload_batches   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER images_updated_at           BEFORE UPDATE ON images           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER product_searches_updated_at BEFORE UPDATE ON product_searches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER listings_updated_at         BEFORE UPDATE ON listings         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER retry_queue_updated_at      BEFORE UPDATE ON retry_queue      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
