-- Whether a tracking item was sent to PayPal (Orders v2 add-tracking), and PayPal's reply.
ALTER TABLE evidence ADD COLUMN paypal_tracking TEXT;        -- sent / failed / skipped_demo / NULL (not sent)
ALTER TABLE evidence ADD COLUMN paypal_tracking_detail TEXT; -- short message or PayPal error
