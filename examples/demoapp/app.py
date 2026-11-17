from flask import Flask

app = Flask(__name__)
app.config.update(SECRET_KEY="dev-secret", DB_PASSWORD="hunter2", API_TOKEN="abc123", STRIPE_KEY="sk_test", GREETING="hello")
