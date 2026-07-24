"""SMS login delivery-mode regressions.

Development runs without a paid SMS provider must never claim that an SMS was
sent.  They deliberately expose a short-lived local debug code instead; user
builds keep returning a provider error when their SMS service is unavailable.
"""
from __future__ import annotations


def test_dev_sms_send_marks_local_debug_delivery(client, monkeypatch):
    for key in (
        "LINTU_SMS_ACCESS_KEY",
        "LINTU_SMS_ACCESS_SECRET",
        "LINTU_SMS_SIGN_NAME",
        "LINTU_SMS_TEMPLATE_CODE",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("LINTU_BUILD_FLAVOR", "dev")

    response = client.post("/api/auth/sms/send", json={"phone": "18698765432"})

    assert response.status_code == 200
    body = response.json()
    assert body["delivery"] == "local_debug"
    assert body["debug_code"].isdigit()
    assert len(body["debug_code"]) == 6
